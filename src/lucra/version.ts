/**
 * The pinned Lucra Web SDK (spec §7.1, §9): reported by `/health`, and the
 * version phase 4b initializes in the browser.
 *
 * OPEN: (§17.1) the package is not published to the public npm registry —
 * `npm view lucra-web-sdk` answers 404 — and the documented install is straight
 * from GitHub (`bun install Lucra-Sports/lucra-web-sdk`, "installing from Github
 * should be supported by any node package manager"). A GitHub dependency would
 * make `npm i` reach GitHub on every install, so the pin is recorded here and
 * not in `package.json`; `src/lucra/version.test.ts` keeps the two in step if
 * the package is ever added. Release: https://github.com/Lucra-Sports/lucra-web-sdk/releases/tag/v1.12.0
 */
export const LUCRA_SDK_PACKAGE = "lucra-web-sdk" as const;
export const LUCRA_SDK_VERSION = "1.12.0" as const;
/** What `package.json` would pin once the package is installable; the tag equals the version. */
export const LUCRA_SDK_SOURCE = `github:Lucra-Sports/${LUCRA_SDK_PACKAGE}#v${LUCRA_SDK_VERSION}` as const;

/**
 * State coverage (§17.7). Lucra's surfaces disagree (42, 43 and 44 states for
 * different products); nothing in copy states a number. OPEN until the
 * authoritative source for a free-to-play tournament is known; until then the
 * value is `null` and copy says "where Lucra is available".
 */
export const LUCRA_STATE_COVERAGE: number | null = null;
