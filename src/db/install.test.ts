import { expect, test } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "./bun-sqlite";
import { installId } from "./install";
import { migrate } from "./migrate";
import type { Schema } from "./schema";

async function freshDb() {
  const db = new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });
  await migrate(db);
  return db;
}

test("an install keeps one id, and two installs do not share it", async () => {
  const one = await freshDb();
  const two = await freshDb();

  try {
    const first = await installId(one);
    // Read back rather than generated again: a plugin that keyed anything on this would
    // lose it on the next run otherwise.
    expect(await installId(one)).toBe(first);
    expect(await installId(two)).not.toBe(first);
  } finally {
    await one.destroy();
    await two.destroy();
  }
});

test("a host that already knows its tenants can name the install itself", async () => {
  const db = await freshDb();
  const before = process.env.FORGEPOD_INSTALL_ID;
  process.env.FORGEPOD_INSTALL_ID = "tenant-a";

  try {
    expect(await installId(db)).toBe("tenant-a");

    // The setting wins over a stored id rather than being a fallback for a missing one,
    // so moving a database under a host does not keep answering with the old name.
    delete process.env.FORGEPOD_INSTALL_ID;
    const generated = await installId(db);
    process.env.FORGEPOD_INSTALL_ID = "tenant-a";
    expect(generated).not.toBe("tenant-a");
    expect(await installId(db)).toBe("tenant-a");
  } finally {
    if (before === undefined) delete process.env.FORGEPOD_INSTALL_ID;
    else process.env.FORGEPOD_INSTALL_ID = before;
    await db.destroy();
  }
});
