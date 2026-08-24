/**
 * The one file in src/ tied to a runtime, and the reason is not preference:
 * better-sqlite3 crashes Bun 1.3.14 and node:sqlite is unsupported there, so
 * bun:sqlite is the only binding that works. Everything above this file talks to
 * Kysely and knows nothing about it.
 */
import { Database } from "bun:sqlite";
import {
  CompiledQuery,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
} from "kysely";

/** One connection serves everything, so overlapping transactions must not interleave. */
class Mutex {
  #waiting: Array<() => void> = [];
  #held = false;

  async lock(): Promise<void> {
    if (!this.#held) {
      this.#held = true;
      return;
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }

  unlock(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#held = false;
  }
}

class BunSqliteConnection implements DatabaseConnection {
  constructor(private readonly db: Database) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const statement = this.db.prepare(compiled.sql);
    const parameters = compiled.parameters as never[];

    // ponytail: reads are told from writes by the leading keyword, because bun:sqlite
    // exposes no equivalent of better-sqlite3's `reader`. A CTE that writes would be
    // misread; none exist here. Revisit if one ever does.
    if (/^\s*(select|with|pragma)\b/i.test(compiled.sql) || /\breturning\b/i.test(compiled.sql)) {
      return { rows: statement.all(...parameters) as R[] };
    }

    const changes = statement.run(...parameters);
    return {
      rows: [],
      numAffectedRows: BigInt(changes.changes),
      insertId: BigInt(changes.lastInsertRowid),
    };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("bun:sqlite does not stream results");
  }
}

class BunSqliteDriver implements Driver {
  #db?: Database;
  #connection?: BunSqliteConnection;
  readonly #mutex = new Mutex();

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    this.#db = new Database(this.path, { create: true });
    // WAL lets readers run while a write is in flight, which is the difference
    // between a usable single-file database and a queue of blocked requests.
    this.#db.run("pragma journal_mode = wal");
    this.#db.run("pragma foreign_keys = on");
    this.#db.run("pragma busy_timeout = 5000");
    this.#connection = new BunSqliteConnection(this.#db);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    await this.#mutex.lock();
    if (!this.#connection) throw new Error("database was not initialised");
    return this.#connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async releaseConnection(): Promise<void> {
    this.#mutex.unlock();
  }

  async destroy(): Promise<void> {
    this.#db?.close();
  }
}

export class BunSqliteDialect implements Dialect {
  constructor(private readonly path: string) {}

  createDriver(): Driver {
    return new BunSqliteDriver(this.path);
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely's own Dialect signature
  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }
}
