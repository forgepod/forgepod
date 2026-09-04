import { expect, test } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "./bun-sqlite";
import { migrate } from "./migrate";
import type { Schema } from "./schema";

const freshDb = () => new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });

const columnsOf = async (db: Kysely<Schema>, table: string) => {
  const tables = await db.introspection.getTables();
  return tables.find((t) => t.name === table)?.columns.map((c) => c.name) ?? [];
};

test("an agent carries an owner and a run carries its actor", async () => {
  const db = freshDb();
  try {
    await migrate(db);
    expect(await columnsOf(db, "agents")).toContain("owner_id");
    expect(await columnsOf(db, "runs")).toContain("actor_id");
  } finally {
    await db.destroy();
  }
});

// The real case: an install that predates ownership, where the agents table exists
// without owner_id before migrate() ever runs. Building it via migrate() first would
// create owner_id in the same createTable call and never exercise the ALTER path in
// addColumnIfMissing, which is the only reason that helper exists. So this test builds
// the pre-ownership table shape by hand.
test("owner_id reaches an agents table that predates ownership", async () => {
  const db = freshDb();
  try {
    await db.schema
      .createTable("agents")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("slug", "text", (c) => c.notNull().unique())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("published_version_id", "text")
      .execute();

    // Raw insert: the typed Insertable now expects owner_id, but this table does not
    // have it yet, which is the whole point of the test.
    await sql`insert into agents (id, slug, name, created_at, published_version_id)
      values ('a1', 'old', 'Old', '2026-01-01T00:00:00.000Z', null)`.execute(db);

    await migrate(db);

    expect(await columnsOf(db, "agents")).toContain("owner_id");
    const row = await db.selectFrom("agents").selectAll().where("id", "=", "a1").executeTakeFirst();
    expect(row?.name).toBe("Old");
    expect(row?.owner_id).toBeNull();

    // Idempotency: a second migrate against a database that already has the column
    // must not throw on a duplicate ALTER.
    await migrate(db);
  } finally {
    await db.destroy();
  }
});

// runs/actor_id goes through the same addColumnIfMissing helper with the same
// existence guard as agents/owner_id above; not re-covered here to avoid a second
// hand-built table fixture for the same code path.
