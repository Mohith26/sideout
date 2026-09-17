import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const stub = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": stub("./src"),
      // `server-only` throws outside a React Server environment. Tests exercise
      // server modules directly, so the poison pill is swapped for an inert stub.
      "server-only": stub("./src/test/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
    setupFiles: ["./src/test/setup.ts"],
    env: {
      LUCRA_MODE: "mock",
    },
  },
});
