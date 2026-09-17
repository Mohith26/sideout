import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The BACKEND Lucra key lives only in `src/env.ts`. This test walks the static
 * import graph from every client module (`"use client"`) and asserts none of
 * them can reach the server env, the database client, or any `server-only`
 * module. Together with the `server-only` import (a build-time error in Next)
 * this is the guard behind spec §5 and acceptance #12.
 */

const SRC = resolve(process.cwd(), "src");

const FORBIDDEN_FOR_CLIENTS = new Set(
  ["src/env.ts", "src/db/client.ts", "src/db/connection.ts", "src/db/migrations.ts"].map((p) => resolve(process.cwd(), p)),
);
const FORBIDDEN_DIRS = ["src/db/queries"].map((p) => resolve(process.cwd(), p));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

// Static `import ... from "x"`, side-effect `import "x"`, re-exports, and dynamic `import("x")`.
const IMPORT_RE = /(?:import|export)\s+(?:[^;'"]*?from\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function specifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (spec) out.push(spec);
  }
  return out;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // package import
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not this candidate; try the next extension
      continue;
    }
  }
  return null;
}

function isClientModule(source: string): boolean {
  return /^\s*(?:\/\/.*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']\s*;?/.test(source);
}

function importsServerOnly(source: string): boolean {
  return specifiers(source).includes("server-only");
}

describe("client/server env boundary", () => {
  const files = walk(SRC);
  const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")] as const));
  const clientRoots = files.filter((f) => isClientModule(sources.get(f) ?? ""));

  it("has client modules to check", () => {
    expect(clientRoots.length).toBeGreaterThan(0);
  });

  it("src/env.ts is server-only and src/env.public.ts is not", () => {
    expect(importsServerOnly(sources.get(resolve(SRC, "env.ts")) ?? "")).toBe(true);
    expect(importsServerOnly(sources.get(resolve(SRC, "env.public.ts")) ?? "")).toBe(false);
    expect(sources.get(resolve(SRC, "env.public.ts")) ?? "").not.toMatch(/LUCRA_BACKEND_API_KEY|LUCRA_WEBHOOK_SECRET/);
  });

  it("no client module transitively imports the server env, the database, or a server-only module", () => {
    const offenders: string[] = [];
    for (const root of clientRoots) {
      const seen = new Set<string>();
      const stack = [root];
      while (stack.length) {
        const file = stack.pop();
        if (!file || seen.has(file)) continue;
        seen.add(file);
        const source = sources.get(file) ?? readFileSync(file, "utf8");
        const forbidden =
          FORBIDDEN_FOR_CLIENTS.has(file) ||
          FORBIDDEN_DIRS.some((d) => file.startsWith(d)) ||
          (file !== root && importsServerOnly(source));
        if (forbidden) {
          offenders.push(`${relative(process.cwd(), root)} -> ${relative(process.cwd(), file)}`);
          continue;
        }
        for (const spec of specifiers(source)) {
          const target = resolveSpecifier(file, spec);
          if (target) stack.push(target);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the raw backend key name appears only in the server env module and docs", () => {
    const leaks = files.filter((f) => f !== resolve(SRC, "env.ts") && (sources.get(f) ?? "").includes("LUCRA_BACKEND_API_KEY"));
    expect(leaks.map((f) => relative(process.cwd(), f))).toEqual([]);
  });
});
