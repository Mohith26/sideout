import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The copy audit (spec §4.4, §11.3, §14), kept as a test so it stays true:
 * no screen implies legal clearance or hardcodes a state count, no dispute
 * copy assigns blame, no emoji stands in for an icon, and none of the banned
 * visual treatments appear in a component. Words are matched on the source
 * of every screen and component, comments included, so a phrase cannot hide
 * in a string the grep would miss.
 */
const ROOT = new URL("./", import.meta.url).pathname;

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(tsx|ts|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const SCREENS = [...files(join(ROOT, "app")), ...files(join(ROOT, "components")), join(ROOT, "styles/tokens.css"), join(ROOT, "styles/motion.css")];

/** Every line matching `pattern`, as "path:line: text", unless `allow` excuses it (the full line is what `allow` sees). */
function offenders(pattern: RegExp, allow: (path: string, line: string) => boolean = () => false): string[] {
  const hits: string[] = [];
  for (const path of SCREENS) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (pattern.test(line) && !allow(relative(ROOT, path), line)) hits.push(`${relative(ROOT, path)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return hits;
}

describe("copy audit", () => {
  it("never implies legal clearance and never hardcodes a state count (§4.1, §4.4)", () => {
    const legal = /\b(licen[sc]ed|compliant|legal clearance|lawful|legally|permitted in your state|eligible in|approved by|regulator)\b/i;
    expect(offenders(legal)).toEqual([]);
    expect(offenders(/\b(4[0-9]|50)\s+states\b/i)).toEqual([]);
  });

  it("dispute copy assigns no blame: two readings differ, nobody lied (§11.3)", () => {
    const blame = /\b(cheat\w*|lie[ds]?|lying|liar|dishonest|fraud\w*|at fault|blamed?|wrong team|false score|fake)\b/i;
    // The one mention is the ConsensusBadge's own note saying exactly this.
    expect(offenders(blame, (path, line) => path === "components/consensus/ConsensusBadge.tsx" && line.includes("not a team that lied"))).toEqual([]);
  });

  it("uses no casino vocabulary for play: prizes are rewards, entry is a donation, nothing is a bet (§4)", () => {
    const casino = /\b(bets?|betting|gambl\w*|casino|jackpot|odds|bookmaker|house edge|cash ?out)\b/i;
    expect(offenders(casino)).toEqual([]);
    // "wager" and "stake" appear only as what a donation is not.
    expect(offenders(/\b(wager|staked?)\b/i, (_path, line) => /not a wager|never (mistaken for a wager|staked)|is not a wager/i.test(line))).toEqual([]);
  });

  it("uses no emoji as iconography (§14)", () => {
    expect(offenders(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u)).toEqual([]);
  });

  it("uses none of the banned treatments: gradients, uniform large radii, glassmorphism beyond the sheet backdrop, centered body copy (§14)", () => {
    expect(offenders(/bg-gradient|linear-gradient|from-[a-z]+-\d|indigo|violet|purple/i, (path, line) => path === "app/globals.css" && line.includes("no `text-indigo-500` to reach for"))).toEqual([]);
    expect(offenders(/rounded-(2xl|3xl)/, (path, line) => line.includes("there is no `rounded-2xl`") || path.endsWith("globals.css"))).toEqual([]);
    expect(offenders(/backdrop-(blur|filter)/, (path, line) => path === "app/globals.css" && /dialog::backdrop|backdrop-filter: blur\(8px\)/.test(line))).toEqual([]);
    // Centered text belongs to inputs, table cells and wrapping buttons, never to a paragraph.
    expect(offenders(/<p[^>]*text-center/)).toEqual([]);
  });

  it("sets no text below the 13px label tier (§12.2, §14)", () => {
    expect(offenders(/text-\[(\d+)px\]/, (_path, line) => [...line.matchAll(/text-\[(\d+)px\]/g)].every((m) => Number(m[1]) >= 13))).toEqual([]);
    const tokens = readFileSync(join(ROOT, "styles/tokens.css"), "utf8");
    expect(tokens).toMatch(/--fs-body:\s*0\.9375rem/);
    expect(tokens).toMatch(/--fs-label:\s*0\.8125rem/);
  });
});
