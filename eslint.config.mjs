import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const restrictedImports = {
  paths: [
    {
      name: "@/env",
      importNames: ["default"],
      message: "Import the named `env` export.",
    },
  ],
  patterns: [
    {
      group: ["**/log", "!@/lib/log"],
      message: "Log through @/lib/log only.",
    },
  ],
};

/**
 * Spec §5, §8: the adapter is the single module allowed to make outbound
 * Lucra calls. Outside `src/lucra/`, the real client and the mock are not
 * importable — `@/lucra` (the adapter and the types) is the whole surface —
 * and nothing may name a Lucra host in a fetch. `src/lucra/import-boundary.test.ts`
 * runs ESLint over fixtures to prove each rule fires.
 */
const serverLucraPattern = {
  group: ["**/lucra/client", "**/lucra/mock", "@/lucra/client", "@/lucra/mock"],
  message: "Only src/lucra/adapter.ts may use the Lucra client or mock; import from @/lucra.",
};

/**
 * Spec §7.5, §12.5: `LucraGate` is the single wrapper that owns the browser
 * SDK; no other component touches it. The real package and the mock stand-in
 * are importable only from `src/components/lucra/LucraGate.tsx` (and its
 * test, which needs the stand-in's error classes); everything else goes
 * through `useLucra()`.
 */
const LUCRA_GATE_FILES = ["src/components/lucra/LucraGate.tsx", "src/components/lucra/LucraGate.test.tsx"];
const browserSdkPattern = {
  group: ["lucra-web-sdk", "lucra-web-sdk/*", "**/lucra/sdk-mock", "@/lucra/sdk-mock"],
  message: "Only src/components/lucra/LucraGate.tsx may load the Lucra Web SDK or its mock stand-in; use useLucra().",
};
const realSdkPattern = {
  group: ["lucra-web-sdk", "lucra-web-sdk/*"],
  message: "Only src/components/lucra/LucraGate.tsx may load the Lucra Web SDK; src/lucra/sdk-surface.ts types it.",
};

const lucraBoundary = {
  ...restrictedImports,
  patterns: [...restrictedImports.patterns, serverLucraPattern, browserSdkPattern],
};

/** What the gate itself may not import: the server client and mock, and the scoreline hash (it is a component). */
const gateBoundary = {
  ...restrictedImports,
  patterns: [
    ...restrictedImports.patterns,
    serverLucraPattern,
    {
      group: ["**/scoreline-hash"],
      message: "The scoreline hash is server-side; components judge legality with @/domain/scoreline alone.",
    },
  ],
};

const LUCRA_HOST_PATTERN = "lucrasports\\.com";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "drizzle/**",
    "playwright-report/**",
    "test-results/**",
    "coverage/**",
  ]),
  {
    rules: {
      // Section 14: `any`, stray console output, and empty catch blocks are banned.
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "all" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "no-restricted-imports": ["error", restrictedImports],
    },
  },
  {
    // Inside src/lucra: the stand-in is internal, but the real browser SDK is still the gate's alone.
    files: ["src/lucra/**"],
    rules: {
      "no-restricted-imports": ["error", { ...restrictedImports, patterns: [...restrictedImports.patterns, realSdkPattern] }],
    },
  },
  {
    // Everything outside src/lucra: no client, no mock, no browser SDK, no fetch against a Lucra host.
    files: ["src/**"],
    ignores: ["src/lucra/**"],
    rules: {
      "no-restricted-imports": ["error", lucraBoundary],
      "no-restricted-syntax": [
        "error",
        {
          selector: `CallExpression[callee.name='fetch'] > :matches(Literal, TemplateLiteral)[value=/${LUCRA_HOST_PATTERN}/], CallExpression[callee.name='fetch'] > TemplateLiteral > TemplateElement[value.raw=/${LUCRA_HOST_PATTERN}/]`,
          message: "Only src/lucra/adapter.ts (through client.ts) may call a Lucra host; import from @/lucra.",
        },
      ],
    },
  },
  {
    // Components may ship to the browser: the scoreline hash needs Node's
    // crypto and would drag its polyfill into the client bundle.
    files: ["src/components/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          ...lucraBoundary,
          patterns: [
            ...lucraBoundary.patterns,
            {
              group: ["**/scoreline-hash"],
              message: "The scoreline hash is server-side; components judge legality with @/domain/scoreline alone.",
            },
          ],
        },
      ],
    },
  },
  {
    // The one component that loads the browser SDK (real or stand-in).
    files: LUCRA_GATE_FILES,
    rules: {
      "no-restricted-imports": ["error", gateBoundary],
    },
  },
  {
    // The single place console output is permitted (warn/error only).
    files: ["src/lib/log.ts"],
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
]);

export default eslintConfig;
