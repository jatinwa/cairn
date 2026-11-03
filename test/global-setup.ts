import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

let container: StartedPostgreSqlContainer | undefined;

/**
 * Make a Postgres available to the database tests, in preference order:
 *
 * 1. An existing `DATABASE_URL`, which is how CI supplies its service container.
 * 2. A throwaway container started here via testcontainers.
 * 3. Neither — the database tests skip themselves and the rest of the suite
 *    still runs. A missing Docker daemon should not fail a unit-test run.
 *
 * This runs in Vitest's main process, before any worker is forked, so setting
 * `process.env` here is inherited by the workers that run the tests.
 */
export async function setup(): Promise<void> {
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== "") {
    return;
  }

  try {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    process.env.DATABASE_URL = container.getConnectionUri();
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.warn(
      `[cairn] Skipping database tests: could not start Postgres (${detail}). ` +
        `Start Docker, or set DATABASE_URL to an existing server.`,
    );
  }
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
