import { beforeAll, describe, expect, it } from "vitest";

import { checksumOf, loadMigrations, type Migration } from "../src/migrate.js";
import { OPEN_STATUSES_SQL, SCHEMA_NAME } from "../src/sql.js";

describe("checksumOf", () => {
  it("returns 64 hex characters", () => {
    expect(checksumOf("SELECT 1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same input", () => {
    expect(checksumOf("SELECT 1")).toBe(checksumOf("SELECT 1"));
  });

  it("changes when the SQL changes", () => {
    expect(checksumOf("SELECT 1")).not.toBe(checksumOf("SELECT 2"));
  });

  // Without this, the same checkout would produce different checksums on a
  // Windows machine and a Linux CI runner, and every CI run would look like
  // somebody had edited an applied migration.
  it("treats CRLF and LF as identical", () => {
    expect(checksumOf("CREATE TABLE a;\r\nCREATE TABLE b;\r\n")).toBe(
      checksumOf("CREATE TABLE a;\nCREATE TABLE b;\n"),
    );
  });
});

describe("loadMigrations", () => {
  let migrations: Migration[];

  beforeAll(async () => {
    migrations = await loadMigrations();
  });

  it("finds the bundled migrations", () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  it("orders versions ascending with no duplicates", () => {
    const versions = migrations.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort());
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("splits each filename into a version and a name", () => {
    const first = migrations[0]!;
    expect(first.version).toBe("001");
    expect(first.name).toBe("init");
  });

  it("checksums each migration from its own SQL", () => {
    for (const migration of migrations) {
      expect(migration.checksum).toBe(checksumOf(migration.sql));
    }
  });

  it("normalises line endings, so checksums do not depend on the checkout", () => {
    for (const migration of migrations) {
      expect(migration.sql).not.toContain("\r");
    }
  });

  it("creates the cairn schema and the three core tables", () => {
    const sql = migrations.map((migration) => migration.sql).join("\n");
    expect(sql).toContain(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA_NAME}`);
    expect(sql).toContain(`CREATE TABLE ${SCHEMA_NAME}.run`);
    expect(sql).toContain(`CREATE TABLE ${SCHEMA_NAME}.step`);
    expect(sql).toContain(`CREATE TABLE ${SCHEMA_NAME}.task`);
  });

  // `startRun` relies on `ON CONFLICT ... WHERE <predicate>` inferring the
  // partial unique index, which Postgres only does when the predicate it is
  // given implies the index's own. If the two spellings drift, deduplication
  // stops working without any error, so they are pinned together here.
  it("spells the open-status predicate the way OPEN_STATUSES_SQL does", () => {
    const sql = migrations.map((migration) => migration.sql).join("\n");
    expect(sql).toContain(`WHERE ${OPEN_STATUSES_SQL}`);
  });

  // Index names are not schema-qualified — an index lives in its table's
  // schema — so only tables and types are checked here.
  it("qualifies every table and type with the cairn schema", () => {
    for (const migration of migrations) {
      expect(migration.sql).not.toMatch(/CREATE (?:TABLE|TYPE)\s+(?!cairn\.)/);
    }
  });
});
