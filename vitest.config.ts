import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    // Container startup and Postgres DDL are slow relative to unit tests.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Each test file creates its own database on the shared server, so files
    // are safe to run in parallel; forks keep `pg` handles properly isolated.
    pool: "forks",
  },
});
