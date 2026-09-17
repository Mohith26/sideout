/**
 * The pinned Lucra Web SDK version reported by `/health` (spec §7.1, §9).
 *
 * OPEN: (§17.1, phase 4) no SDK package is installed until the Lucra phase, so
 * there is nothing to pin yet. This constant is the single source of truth; the
 * phase 4 task replaces it with the exact `package.json` pin and adds a test that
 * the two agree. Until then the value is honest about being unpinned.
 */
export const LUCRA_SDK_VERSION = "unpinned" as const;
