import { Kysely, PostgresDialect, type Dialect } from "kysely";
import { migrate } from "./migrate";
import type { Schema } from "./schema";

export const databaseUrl = () => process.env.FORGEPOD_DATABASE_URL || "file:forgepod.db";

export const typeFor = (url: string): "sqlite" | "postgres" =>
  url.startsWith("postgres://") || url.startsWith("postgresql://") ? "postgres" : "sqlite";

export async function dialectFor(url: string): Promise<Dialect> {
  if (typeFor(url) === "postgres") {
    const { Pool } = await import("pg");
    return new PostgresDialect({ pool: new Pool({ connectionString: url }) });
  }
  // Imported lazily so a Postgres install never reaches for a Bun-only module.
  const { BunSqliteDialect } = await import("./bun-sqlite");
  return new BunSqliteDialect(url.startsWith("file:") ? url.slice(5) : url);
}

export async function openDatabase(url = databaseUrl()): Promise<Kysely<Schema>> {
  return new Kysely<Schema>({ dialect: await dialectFor(url) });
}

let opened: Promise<Kysely<Schema>> | undefined;

/**
 * Opened once per process and migrated on the way, so nothing else has to remember to.
 *
 * Cleared on failure: `??=` only assigns when `opened` is nullish, and a rejected promise
 * is not nullish. Without the `.catch` below, one transient failure to open or migrate
 * would leave every later call returning that same rejection for the life of the process.
 */
export function database(): Promise<Kysely<Schema>> {
  opened ??= (async () => {
    const db = await openDatabase();
    await migrate(db);
    return db;
  })().catch((err) => {
    opened = undefined;
    throw err;
  });
  return opened;
}

export type { Schema } from "./schema";
