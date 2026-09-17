import { defineConfig } from "drizzle-kit";

// drizzle-kit only needs a path to emit SQL; the app resolves DATABASE_PATH via src/env.ts.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? "./data/sideout.db",
  },
  strict: true,
  verbose: true,
});
