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
const lucraBoundary = {
  ...restrictedImports,
  patterns: [
    ...restrictedImports.patterns,
    {
      group: ["**/lucra/client", "**/lucra/mock", "@/lucra/client", "@/lucra/mock"],
      message: "Only src/lucra/adapter.ts may use the Lucra client or mock; import from @/lucra.",
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
    // Everything outside src/lucra: no client, no mock, no fetch against a Lucra host.
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
    // The single place console output is permitted (warn/error only).
    files: ["src/lib/log.ts"],
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
]);

export default eslintConfig;
