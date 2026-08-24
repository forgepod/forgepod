import type { Kysely } from "kysely";
import type { Schema } from "./schema";

const KEY = "install_id";

/**
 * Names this install to a plugin. It has to exist because a slug is the same on every
 * install of one template: two installs sharing a plugin would otherwise share everything
 * that plugin keeps for them, and each would read the other's memory as its own.
 *
 * Generated once and kept in the database, so it identifies the install rather than the
 * machine or the process, and survives a restart or a move to another host.
 * FORGEPOD_INSTALL_ID overrides it, which is how a host that already knows who its
 * tenants are names them itself.
 */
export async function installId(db: Kysely<Schema>): Promise<string> {
  const set = process.env.FORGEPOD_INSTALL_ID?.trim();
  if (set) return set;

  const stored = await db
    .selectFrom("settings")
    .select("value")
    .where("key", "=", KEY)
    .executeTakeFirst();
  if (stored) return stored.value;

  // Insert and read back rather than insert and return: two requests can reach a fresh
  // install at once, and the one that loses the race must use the row that won.
  await db
    .insertInto("settings")
    .values({ key: KEY, value: crypto.randomUUID() })
    .onConflict((c) => c.column("key").doNothing())
    .execute();

  const row = await db
    .selectFrom("settings")
    .select("value")
    .where("key", "=", KEY)
    .executeTakeFirstOrThrow();
  return row.value;
}
