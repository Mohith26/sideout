import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations, openConnection } from "@/db/connection";
import { migrationsFolder, readJournal, readMigrationState } from "@/db/migrations";

/**
 * Migrations must apply to a live, populated database, not only to the empty
 * one `npm run seed` recreates. This replays the phase-1 schema (0000) by hand,
 * fills it with rows that reference each other, and then runs the real
 * migrator over it.
 */
function applyRaw(sqlite: ReturnType<typeof openConnection>["sqlite"], tag: string) {
  const sql = readFileSync(join(migrationsFolder(), `${tag}.sql`), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const trimmed = stmt.trim();
    if (trimmed) sqlite.prepare(trimmed).run();
  }
}

describe("migrations on a populated phase-1 database", () => {
  it("adds users.role, the forming and disbanded team statuses and tournaments.draw_config_json without losing rows or foreign keys", () => {
    const conn = openConnection(":memory:", { create: true });
    try {
      const journal = readJournal();
      const first = journal.entries[0];
      expect(first?.tag).toBe("0000_init");
      applyRaw(conn.sqlite, first?.tag ?? "");
      // Mark 0000 as applied the way drizzle would, so only later migrations run.
      conn.sqlite.prepare("CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)").run();
      conn.sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('phase1', ?)").run(first?.when ?? 0);
      expect(readMigrationState(conn.sqlite)).toMatchObject({ applied: 1, pending: journal.entries.length - 1 });

      conn.sqlite.prepare("INSERT INTO charities (id, name, mission_short) VALUES ('c1', 'Charity', 'mission')").run();
      conn.sqlite
        .prepare("INSERT INTO users (id, display_name, phone_e164, created_at) VALUES ('u1', 'Maya', '+15550100001', 1), ('u2', 'Ravi', '+15550100002', 2)")
        .run();
      conn.sqlite
        .prepare(
          `INSERT INTO tournaments (id, slug, name, beneficiary_id, venue_name, venue_city, venue_state, venue_timezone, starts_at, ends_at, format, division, max_teams, entry_donation_cents, fundraising_goal_cents, currency, prize_kind, status, lucra_external_id, lucra_game_id, created_at)
           VALUES ('t1', 'slug', 'Event', 'c1', 'v', 'c', 'CA', 'UTC', 1, 2, 'pool_to_bracket', 'open', 8, 0, 0, 'USD', 'free_to_play_rewards', 'live', 'x', 'g', 1)`,
        )
        .run();
      conn.sqlite.prepare("INSERT INTO teams (id, tournament_id, name, seed, status, created_at) VALUES ('team1', 't1', 'Maya / Ravi', 1, 'registered', 3)").run();
      conn.sqlite.prepare("INSERT INTO team_members (id, team_id, user_id, role) VALUES ('tm1', 'team1', 'u1', 'captain'), ('tm2', 'team1', 'u2', 'player')").run();
      conn.sqlite.prepare("INSERT INTO pools (id, tournament_id, label, court_label) VALUES ('p1', 't1', 'Pool A', 'Court 1')").run();
      conn.sqlite.prepare("INSERT INTO pool_teams (id, pool_id, team_id) VALUES ('pt1', 'p1', 'team1')").run();
      conn.sqlite
        .prepare(
          "INSERT INTO matches (id, tournament_id, pool_id, round, team_a_id, best_of, status) VALUES ('m1', 't1', 'p1', 1, 'team1', '1', 'scheduled')",
        )
        .run();
      expect(() => conn.sqlite.prepare("UPDATE teams SET status = 'forming' WHERE id = 'team1'").run()).toThrow(/CHECK constraint failed/);

      const state = applyMigrations(conn);
      expect(state.pending).toBe(0);
      expect(conn.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(conn.sqlite.pragma("foreign_key_check")).toEqual([]);

      const users = conn.sqlite.prepare("SELECT id, role FROM users ORDER BY id").all();
      expect(users).toEqual([
        { id: "u1", role: "player" },
        { id: "u2", role: "player" },
      ]);
      expect(conn.sqlite.prepare("SELECT team_id FROM pool_teams").all()).toEqual([{ team_id: "team1" }]);
      expect(conn.sqlite.prepare("SELECT team_a_id FROM matches").all()).toEqual([{ team_a_id: "team1" }]);
      expect(() => conn.sqlite.prepare("UPDATE teams SET status = 'forming' WHERE id = 'team1'").run()).not.toThrow();
      expect(() => conn.sqlite.prepare("UPDATE teams SET status = 'disbanded' WHERE id = 'team1'").run()).not.toThrow();
      expect(() => conn.sqlite.prepare("UPDATE teams SET status = 'gone' WHERE id = 'team1'").run()).toThrow(/CHECK constraint failed/);
      conn.sqlite.prepare("UPDATE teams SET status = 'registered' WHERE id = 'team1'").run();
      expect(() => conn.sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = 'u1'").run()).toThrow(/CHECK constraint failed/);
      expect(() => conn.sqlite.prepare("UPDATE users SET role = 'organizer' WHERE id = 'u1'").run()).not.toThrow();
      // The new tables exist and enforce their enums.
      expect(() =>
        conn.sqlite
          .prepare("INSERT INTO team_invites (id, team_id, invited_by_user_id, phone_e164, status, created_at) VALUES ('i1', 'team1', 'u1', '+15550100003', 'nope', 1)")
          .run(),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        conn.sqlite
          .prepare("INSERT INTO team_invites (id, team_id, invited_by_user_id, phone_e164, status, created_at) VALUES ('i1', 'ghost', 'u1', '+15550100003', 'pending', 1)")
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(() => conn.sqlite.prepare("INSERT INTO auth_codes (id, phone_e164, code_hash, expires_at, created_at) VALUES ('a1', '+15550100003', 'h', 2, 1)").run()).not.toThrow();
      // 0002: the draw configuration column exists, is empty for a pre-existing event, and takes JSON text.
      expect(conn.sqlite.prepare("SELECT draw_config_json FROM tournaments WHERE id = 't1'").get()).toEqual({ draw_config_json: null });
      expect(() => conn.sqlite.prepare("UPDATE tournaments SET draw_config_json = '{\"courts\":4}' WHERE id = 't1'").run()).not.toThrow();
    } finally {
      conn.close();
    }
  });

  it("refuses to leave a database with dangling foreign keys after a migration", () => {
    const conn = openConnection(":memory:", { create: true });
    try {
      applyMigrations(conn);
      // Simulate a broken migration outcome: a child row pointing nowhere, with enforcement off.
      conn.sqlite.pragma("foreign_keys = OFF");
      conn.sqlite.prepare("INSERT INTO charities (id, name, mission_short) VALUES ('c1', 'Charity', 'mission')").run();
      conn.sqlite.prepare("INSERT INTO sponsors (id, tournament_id, name, tier, prize_contribution_cents, currency) VALUES ('s1', 'ghost', 'x', 'court', 0, 'USD')").run();
      conn.sqlite.pragma("foreign_keys = ON");
      expect(conn.sqlite.pragma("foreign_key_check")).toHaveLength(1);
      expect(() => applyMigrations(conn)).toThrow(/foreign key violation/);
      expect(conn.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      conn.close();
    }
  });
});
