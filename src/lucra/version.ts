/**
 * The pinned Lucra Web SDK (spec §7.1, §9): reported by `/health`, and the
 * version `src/components/lucra/LucraGate.tsx` initializes in the browser.
 *
 * OPEN: (§17.1) the package is not published to the public npm registry —
 * `npm view lucra-web-sdk` answers 404 — and the documented install is straight
 * from GitHub ("installing from Github should be supported by any node package
 * manager"). `package.json` pins the release tag (`github:Lucra-Sports/
 * lucra-web-sdk#v1.12.0`) and the lockfile pins the commit it resolved to;
 * npm fetches the tag's tarball over https, so no SSH access is needed. The
 * pin is repeated here so `/health` and the docs can name it without
 * importing the package on the server, and `src/lucra/version.test.ts` keeps
 * the two in step. Release: https://github.com/Lucra-Sports/lucra-web-sdk/releases/tag/v1.12.0
 */
export const LUCRA_SDK_PACKAGE = "lucra-web-sdk" as const;
export const LUCRA_SDK_VERSION = "1.12.0" as const;
/** The `package.json` spec; the tag equals the version. */
export const LUCRA_SDK_SOURCE = `github:Lucra-Sports/${LUCRA_SDK_PACKAGE}#v${LUCRA_SDK_VERSION}` as const;

/**
 * State coverage (§17.7). Lucra's surfaces disagree (42, 43 and 44 states for
 * different products); nothing in copy states a number. OPEN until the
 * authoritative source for a free-to-play tournament is known; until then the
 * value is `null` and copy says "where Lucra is available".
 */
export const LUCRA_STATE_COVERAGE: number | null = null;
