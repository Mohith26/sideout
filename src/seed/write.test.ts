import { describe, expect, it } from "vitest";
import { applyMigrations, openConnection } from "@/db/connection";
import { readMigrationState } from "@/db/migrations";
import { buildSeed, DEFAULT_RNG_SEED } from "@/seed/build";
import { writeSeed } from "@/seed/write";

const ANCHOR = Date.UTC(2026, 8, 19, 7);

describe("seed writes to a migrated database", () => {
  it("reports migrations as pending on a fresh database and applied afterwards", () => {
    const conn = openConnection(":memory:", { create: true });
    try {
      const fresh = readMigrationState(conn.sqlite);
      expect(fresh.applied).toBe(0);
      expect(fresh.available).toBeGreaterThan(0);
      expect(fresh.pending).toBe(fresh.available);
      const after = applyMigrations(conn);
      expect(after.pending).toBe(0);
      expect(after.applied).toBe(after.available);
      // Re-applying is a no-op.
      expect(applyMigrations(conn)).toEqual(after);
    } finally {
      conn.close();
    }
  });

  it("inserts the full dataset under check and foreign-key constraints, idempotently", () => {
    const conn = openConnection(":memory:", { create: true });
    try {
      applyMigrations(conn);
      const dataset = buildSeed({ anchorMs: ANCHOR, rngSeed: DEFAULT_RNG_SEED });
      const first = writeSeed(conn, dataset);
      expect(first.counts.users).toBe(48);
      expect(first.counts.tournaments).toBe(3);
      expect(first.counts.matches).toBe(dataset.matches.length);

      const fkViolations = conn.sqlite.prepare("PRAGMA foreign_key_check").all();
      expect(fkViolations).toEqual([]);

      const count = (table: string) =>
        (conn.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count("team_members")).toBe(dataset.teamMembers.length);
      expect(count("lucra_score_submissions")).toBe(0);
      expect(count("webhook_events")).toBe(0);

      const second = writeSeed(conn, dataset);
      expect(second).toEqual(first);
      expect(count("matches")).toBe(dataset.matches.length);
      expect(count("audit_log")).toBe(dataset.auditLog.length);
    } finally {
      conn.close();
    }
  });

  it("keeps the donation ledger and the prize ledger apart: no foreign key between them", () => {
    const conn = openConnection(":memory:", { create: true });
    try {
      applyMigrations(conn);
      const ledgers: readonly string[] = ["donations", "sponsors", "rewards"];
      for (const table of ledgers) {
        const referenced = (conn.sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>).map(
          (fk) => fk.table,
        );
        expect(referenced).toContain("tournaments");
        expect(referenced.filter((t) => t !== table && ledgers.includes(t))).toEqual([]);
      }
    } finally {
      conn.close();
    }
  });

  it("enforces the enum check constraints the schema declares", () => {
    const conn = openConnection(":memory:", { create: true });
    try {
      applyMigrations(conn);
      expect(() =>
        conn.sqlite
          .prepare("INSERT INTO charities (id, name, mission_short) VALUES ('c1', 'x', 'y')")
          .run(),
      ).not.toThrow();
      expect(() =>
        conn.sqlite
          .prepare(
            `INSERT INTO tournaments (id, slug, name, beneficiary_id, venue_name, venue_city, venue_state, venue_timezone, starts_at, ends_at, format, division, max_teams, entry_donation_cents, fundraising_goal_cents, currency, prize_kind, status, lucra_external_id, lucra_game_id, created_at)
             VALUES ('t1', 's', 'n', 'c1', 'v', 'c', 'CA', 'UTC', 1, 2, 'pool_to_bracket', 'open', 8, 0, 0, 'USD', 'free_to_play_rewards', 'not_a_status', 'x', 'g', 1)`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      conn.close();
    }
  });
});
