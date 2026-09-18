import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { applyMigrations, openConnection, type Connection } from "@/db/connection";
import { auditLog } from "@/db/schema";
import { env } from "@/env";
import { failEnvelopeSchema } from "@/lib/api";
import { installLucraAdapter } from "@/lucra";
import { REQUEST_CODE_LIMITS, VERIFY_CODE_LIMITS } from "@/server/auth/codes";
import { resetLucraForTests } from "@/server/lucra";
import { SESSION_COOKIE, signSession } from "@/server/auth/session";
import { buildSeed, DEFAULT_RNG_SEED, startOfTodayIn, VENUE_TIMEZONE, type SeedDataset, type SLUGS } from "@/seed/build";
import { writeSeed } from "@/seed/write";

/**
 * Route-test harness: a migrated temporary SQLite file, optionally seeded,
 * installed as the process-wide connection the services use, plus a `call`
 * helper that invokes a route handler the way Next would.
 */

export interface RouteResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  /** Value of the session cookie set by the response, "" when cleared, undefined when untouched. */
  sessionCookie: string | undefined;
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  /** Raw request body; wins over `body`. */
  rawBody?: string;
  cookie?: string;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}

/**
 * Any route handler. `Promise<never>` for the params makes every concrete
 * `RouteContext<"/…/[id]">` assignable here; the harness supplies the object.
 */
type Handler = (request: NextRequest, ctx: { params: Promise<never> }) => Promise<Response> | Response;

export interface TestApp {
  conn: Connection;
  data: SeedDataset;
  anchorMs: number;
  call<T = unknown>(handler: Handler, path: string, options?: CallOptions): Promise<RouteResponse<T>>;
  /** A valid session cookie header value for `userId`. */
  cookieFor(userId: string): string;
  organizer(): SeedDataset["users"][number];
  player(): SeedDataset["users"][number];
  tournament(slug: (typeof SLUGS)[keyof typeof SLUGS]): SeedDataset["tournaments"][number];
  audits(subjectId: string, action?: string): Array<typeof auditLog.$inferSelect>;
  close(): void;
}

declare global {
  var __sideoutDb: Connection | undefined;
}

export function createTestApp(options: { seed?: boolean } = {}): TestApp {
  const dir = mkdtempSync(join(tmpdir(), "sideout-routes-"));
  const conn = openConnection(join(dir, "routes.db"), { create: true });
  applyMigrations(conn);
  const anchorMs = startOfTodayIn(VENUE_TIMEZONE);
  const data = buildSeed({ anchorMs, rngSeed: DEFAULT_RNG_SEED });
  if (options.seed !== false) writeSeed(conn, data);
  globalThis.__sideoutDb?.close();
  globalThis.__sideoutDb = conn;
  for (const limiter of [...Object.values(REQUEST_CODE_LIMITS), ...Object.values(VERIFY_CODE_LIMITS)]) limiter.reset();
  // A fresh Lucra adapter (and mock) per database: the mock is seeded from these rows on first use.
  installLucraAdapter(undefined);
  resetLucraForTests();

  const cookieFor = (userId: string) => `${SESSION_COOKIE}=${signSession(userId, env.sessionSecret)}`;

  return {
    conn,
    data,
    anchorMs,
    cookieFor,
    async call<T>(handler: Handler, path: string, opts: CallOptions = {}): Promise<RouteResponse<T>> {
      const headers = new Headers(opts.headers ?? {});
      const method = opts.method ?? "GET";
      const rawBody = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
      if (rawBody !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
      if (opts.cookie) headers.set("cookie", opts.cookie);
      const request = new NextRequest(new URL(path, "http://sideout.test"), {
        method,
        headers,
        ...(rawBody === undefined ? {} : { body: rawBody }),
      });
      const response = await handler(request, { params: Promise.resolve(opts.params ?? {}) as unknown as Promise<never> });
      const text = await response.text();
      const setCookie = response.headers.get("set-cookie");
      const match = setCookie?.match(new RegExp(`${SESSION_COOKIE}=([^;]*)`));
      return {
        status: response.status,
        headers: response.headers,
        body: (text ? JSON.parse(text) : null) as never,
        sessionCookie: match ? match[1] : undefined,
      };
    },
    organizer() {
      const u = data.users.find((x) => x.role === "organizer");
      if (!u) throw new Error("seed has no organizer");
      return u;
    },
    player() {
      const u = data.users.find((x) => x.role === "player");
      if (!u) throw new Error("seed has no player");
      return u;
    },
    tournament(slug) {
      const t = data.tournaments.find((x) => x.slug === slug);
      if (!t) throw new Error(`seed has no tournament ${slug}`);
      return t;
    },
    audits(subjectId, action) {
      return conn.db
        .select()
        .from(auditLog)
        .all()
        .filter((a) => a.subjectId === subjectId && (action === undefined || a.action === action))
        .sort((x, y) => x.createdAt - y.createdAt);
    },
    close() {
      if (globalThis.__sideoutDb === conn) globalThis.__sideoutDb = undefined;
      conn.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Assert a failure envelope and return its error. */
export function expectFailure(res: RouteResponse, status: number, code: string) {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  const parsed = failEnvelopeSchema.parse(res.body);
  if (parsed.error.code !== code) throw new Error(`expected code ${code}, got ${parsed.error.code}: ${parsed.error.message}`);
  return parsed.error;
}
