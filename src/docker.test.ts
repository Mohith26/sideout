import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The container is reproducible from the repository (docs/deploy.md,
 * "Railway"): the runtime stage carries production dependencies plus the
 * built app and nothing local, and the service start command is the same in
 * both places it is written.
 */
const root = resolve(__dirname, "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));

const START_COMMAND = '(test -f "$DATABASE_PATH" || npm run seed) && npm run db:migrate && npm run start';

describe(".dockerignore", () => {
  const entries = lines(read(".dockerignore"));

  it("keeps every env file but the example out of the build context", () => {
    expect(entries).toContain(".env");
    expect(entries).toContain(".env.*");
    expect(entries).toContain("!.env.example");
    expect(entries).toContain("*.pem");
  });

  it("keeps local databases, build output and node_modules out", () => {
    for (const entry of ["data", ".next", "node_modules", ".git"]) expect(entries).toContain(entry);
  });
});

describe("Dockerfile", () => {
  const dockerfile = read("Dockerfile");
  const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));

  it("prunes dev dependencies before the runtime stage copies node_modules", () => {
    expect(dockerfile).toContain("npm prune --omit=dev");
    expect(runtime).toContain("COPY --from=build --chown=node:node /app/node_modules ./node_modules");
  });

  it("runs the app as the node user through the entrypoint, with the health check on /health", () => {
    expect(runtime).toContain('ENTRYPOINT ["docker-entrypoint.sh"]');
    const entrypoint = read("docker-entrypoint.sh");
    expect(entrypoint).toContain("setpriv --reuid=node --regid=node --init-groups");
    expect(entrypoint).toContain('chown node:node "$DATA_DIR"');
    expect(runtime).toMatch(/HEALTHCHECK[\s\S]*\/health/);
  });

  it("copies no env file into the runtime stage", () => {
    expect(runtime).not.toMatch(/COPY[^\n]*\.env/);
  });

  it("starts with the same command railway.json declares", () => {
    expect(dockerfile).toContain(JSON.stringify(START_COMMAND));
    const railway = JSON.parse(read("railway.json")) as { deploy: { startCommand: string; healthcheckPath: string } };
    expect(railway.deploy.startCommand).toBe(START_COMMAND);
    expect(railway.deploy.healthcheckPath).toBe("/health");
  });

  it("has tsx as a production dependency, because the start command's CLIs run on it", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.dependencies.tsx).toBeDefined();
    expect(pkg.devDependencies.tsx).toBeUndefined();
  });
});
