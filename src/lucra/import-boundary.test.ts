import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * Spec §5's third hard rule, enforced rather than advised: the adapter is the
 * only module that talks to Lucra. This runs the repo's ESLint config over
 * in-memory fixtures placed at paths outside and inside `src/lucra/` and
 * asserts the boundary rules fire exactly where they should.
 */
const eslint = new ESLint({ cwd: process.cwd() });

async function messagesFor(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax").map((m) => m.message);
}

describe("Lucra import boundary (ESLint)", () => {
  it("refuses the client and the mock outside src/lucra", async () => {
    const outside = "src/server/rogue.ts";
    expect(await messagesFor(outside, 'import { createLucraClient } from "@/lucra/client";\nexport const x = createLucraClient;\n')).toEqual([expect.stringContaining("Only src/lucra/adapter.ts may use the Lucra client or mock")]);
    expect(await messagesFor(outside, 'import { createLucraMock } from "@/lucra/mock";\nexport const x = createLucraMock;\n')).toEqual([expect.stringContaining("Only src/lucra/adapter.ts may use the Lucra client or mock")]);
    expect(await messagesFor(outside, 'import { LucraMock } from "../lucra/mock";\nexport const x = LucraMock;\n')).toEqual([expect.stringContaining("Only src/lucra/adapter.ts may use the Lucra client or mock")]);
    expect(await messagesFor("src/components/Rogue.tsx", 'import type { LucraClient } from "@/lucra/client";\nexport type X = LucraClient;\n')).toEqual([expect.stringContaining("Only src/lucra/adapter.ts may use the Lucra client or mock")]);
  });

  it("allows the public surface and the types everywhere", async () => {
    expect(await messagesFor("src/server/fine.ts", 'import { getLucraAdapter } from "@/lucra";\nexport const x = getLucraAdapter;\n')).toEqual([]);
    expect(await messagesFor("src/seed/fine.ts", 'import type { CallRecord } from "@/lucra/types";\nexport type X = CallRecord;\n')).toEqual([]);
    expect(await messagesFor("src/lucra/adapter.ts", 'import { createLucraClient } from "@/lucra/client";\nimport { createLucraMock } from "@/lucra/mock";\nexport const x = [createLucraClient, createLucraMock];\n')).toEqual([]);
  });

  it("refuses a fetch against a Lucra host outside src/lucra", async () => {
    const outside = "src/server/rogue.ts";
    expect(await messagesFor(outside, 'export const r = fetch("https://api.sandbox.lucrasports.com/api/rest/user-score");\n')).toEqual([expect.stringContaining("may call a Lucra host")]);
    expect(await messagesFor(outside, 'const id = "x";\nexport const r = fetch(`https://api.lucrasports.com/api/rest/pool-tournament/${id}`);\n')).toEqual([expect.stringContaining("may call a Lucra host")]);
    expect(await messagesFor(outside, 'export const r = fetch("https://example.com/health");\n')).toEqual([]);
    expect(await messagesFor("src/lucra/client.ts", 'export const r = fetch("https://api.lucrasports.com/x");\n')).toEqual([]);
  });

  it("keeps the browser SDK and its stand-in behind LucraGate (spec §7.5, §12.5)", async () => {
    const gateOnly = expect.stringContaining("Only src/components/lucra/LucraGate.tsx may load the Lucra Web SDK");
    expect(await messagesFor("src/components/profile/Rogue.tsx", 'import { LucraClient } from "lucra-web-sdk";\nexport const x = LucraClient;\n')).toEqual([gateOnly]);
    expect(await messagesFor("src/components/profile/Rogue.tsx", 'import { LucraClient } from "@/lucra/sdk-mock";\nexport const x = LucraClient;\n')).toEqual([gateOnly]);
    expect(await messagesFor("src/app/me/page.tsx", 'import type { LucraApiErrorCode } from "lucra-web-sdk";\nexport type X = LucraApiErrorCode;\n')).toEqual([gateOnly]);
    expect(await messagesFor("src/server/rogue.ts", 'import { LucraApiError } from "../lucra/sdk-mock";\nexport const x = LucraApiError;\n')).toEqual([gateOnly]);
    // Inside src/lucra the stand-in is internal, the real package still is not.
    expect(await messagesFor("src/lucra/sdk-mock.test.ts", 'import { LucraClient } from "@/lucra/sdk-mock";\nexport const x = LucraClient;\n')).toEqual([]);
    expect(await messagesFor("src/lucra/rogue.ts", 'import { LucraClient } from "lucra-web-sdk";\nexport const x = LucraClient;\n')).toEqual([gateOnly]);
    // The gate may load both, and still may not reach the server client, the mock, or the hash.
    const gate = "src/components/lucra/LucraGate.tsx";
    expect(await messagesFor(gate, 'const real = () => import("lucra-web-sdk");\nconst mock = () => import("@/lucra/sdk-mock");\nexport const x = [real, mock];\n')).toEqual([]);
    expect(await messagesFor(gate, 'import { createLucraMock } from "@/lucra/mock";\nexport const x = createLucraMock;\n')).toEqual([expect.stringContaining("Only src/lucra/adapter.ts may use the Lucra client or mock")]);
    expect(await messagesFor(gate, 'import { hashScoreline } from "@/domain/scoreline-hash";\nexport const x = hashScoreline;\n')).toEqual([expect.stringContaining("scoreline hash is server-side")]);
    // Everything else reaches the SDK through the gate's hook and the client-safe types.
    expect(await messagesFor("src/components/profile/Fine.tsx", 'import { useLucra } from "@/components/lucra/LucraGate";\nimport type { LucraUiFailure } from "@/lucra/sdk-surface";\nexport const x = useLucra;\nexport type Y = LucraUiFailure;\n')).toEqual([]);
  });
});
