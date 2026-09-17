import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, openConnection } from "@/db/connection";
import { failEnvelopeSchema, okEnvelopeSchema } from "@/lib/api";
import { z } from "zod";

const healthSchema = z.object({
  buildSha: z.string().min(1),
  lucraMode: z.enum(["mock", "sandbox", "production"]),
  lucraSdkVersion: z.string().min(1),
  migrations: z.object({ applied: z.number(), available: z.number(), pending: z.number() }),
});

async function loadRoute() {
  vi.resetModules();
  return import("./route");
}

describe("GET /health", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sideout-health-"));
    dbPath = join(dir, "health.db");
    vi.stubEnv("LUCRA_MODE", "mock");
    vi.stubEnv("DATABASE_PATH", dbPath);
    vi.stubEnv("BUILD_SHA", "abc123");
    vi.stubEnv("LUCRA_BACKEND_API_KEY", "super-secret-backend-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports unavailable with migration state when the database is missing", async () => {
    const { GET } = await loadRoute();
    const res = await GET();
    expect(res.status).toBe(503);
    const body = failEnvelopeSchema.parse(await res.json());
    expect(body.error.code).toBe("unavailable");
    const detail = healthSchema.parse(body.error.detail);
    expect(detail.migrations.applied).toBe(0);
    expect(detail.migrations.pending).toBe(detail.migrations.available);
    expect(detail.migrations.available).toBeGreaterThan(0);
  });

  it("reports ok with applied migrations, build sha, mode and SDK version — and no secrets", async () => {
    const conn = openConnection(dbPath, { create: true });
    applyMigrations(conn);
    conn.close();

    const { GET } = await loadRoute();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const body = okEnvelopeSchema(healthSchema).parse(JSON.parse(text));
    expect(body.data).toMatchObject({ buildSha: "abc123", lucraMode: "mock", lucraSdkVersion: "unpinned" });
    expect(body.data.migrations.pending).toBe(0);
    expect(body.data.migrations.applied).toBe(body.data.migrations.available);
    expect(text).not.toContain("super-secret-backend-key");
    expect(text).not.toMatch(/API_KEY|SECRET|DATABASE_PATH/i);
    expect(text).not.toContain(dbPath);
  });
});
