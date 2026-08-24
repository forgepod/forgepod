import { Kysely, PostgresDialect, type Dialect } from "kysely";
import { migrate } from "./migrate";
import type { Schema } from "./schema";

export const databaseUrl = () => process.env.FORGEPOD_DATABASE_URL || "file:forgepod.db";

export async function dialectFor(url: string): Promise<Dialect> {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
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

/** Opened once per process and migrated on the way, so nothing else has to remember to. */
export function database(): Promise<Kysely<Schema>> {
  opened ??= (async () => {
    const db = await openDatabase();
    await migrate(db);
    return db;
  })();
  return opened;
}

export type { Schema } from "./schema";
