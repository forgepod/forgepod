import { expect, test } from "bun:test";
import { Kysely } from "kysely";
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

// The real case: an install that already has rows. A second migrate must add the column
// without touching the row, and a third must do nothing rather than fail on a duplicate.
test("the new columns reach a database that already holds agents", async () => {
  const db = freshDb();
  try {
    await migrate(db);
    await db
      .insertInto("agents")
      .values({
        id: "a1",
        slug: "old",
        name: "Old",
        created_at: "2026-01-01T00:00:00.000Z",
        published_version_id: null,
        owner_id: null,
      })
      .execute();

    await migrate(db);
    await migrate(db);

    const row = await db.selectFrom("agents").selectAll().where("id", "=", "a1").executeTakeFirst();
    expect(row?.owner_id).toBeNull();
    expect(row?.name).toBe("Old");
  } finally {
    await db.destroy();
  }
});
