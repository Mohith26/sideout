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
    // Components may ship to the browser: the scoreline hash needs Node's
    // crypto and would drag its polyfill into the client bundle.
    files: ["src/components/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          ...restrictedImports,
          patterns: [
            ...restrictedImports.patterns,
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
