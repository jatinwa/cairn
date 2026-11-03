import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    // Pulling and starting a Postgres container on a cold machine is slow.
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // Each database test creates its own database on the shared server, so
    // files are safe in parallel; forks keep `pg` handles properly isolated.
    pool: "forks",
  },
});
