import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { adminAc } from "better-auth/plugins/admin/access";
import { apiKey } from "@better-auth/api-key";
import type { Kysely } from "kysely";
import { database, databaseUrl } from "../db";
import type { Schema } from "../db/schema";

/**
 * Sessions are signed with this. A generated fallback would differ between processes and
 * change on every restart, so every session would end at a deploy and nothing would say
 * why. It refuses instead, the same way `defaultModel` refuses to guess a model id.
 */
export function authSecret(env: Record<string, string | undefined> = process.env): string {
  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set. Auth cannot start without it: it signs every " +
        "session, and a generated default would sign people out on each restart.",
    );
  }
  return secret;
}

/**
 * Takes the database rather than opening one, so auth rides the connection core already
 * has. `type` is passed explicitly because Better Auth otherwise identifies the database
 * with `instanceof SqliteDialect | PostgresDialect | ...`, and `BunSqliteDialect` is ours
 * and matches none of them.
 *
 * The `{ db, type }` shape is used rather than wrapping `db` with the `kyselyAdapter`
 * export: that wrapper turns into a plain function, and `getMigrations` (called from
 * `auth()` below) can only build its own Kysely instance for schema introspection from
 * this raw shape. A function-shaped `database` option works for every other Better Auth
 * operation but leaves migrations unable to see the database at all.
 */
export function createAuth(
  db: Kysely<Schema>,
  type: "sqlite" | "postgres",
  env: Record<string, string | undefined> = process.env,
) {
  return betterAuth({
    secret: authSecret(env),
    baseURL: env.FORGEPOD_BASE_PATH ?? env.BETTER_AUTH_URL,
    database: { db, type },
    emailAndPassword: { enabled: true },
    plugins: [
      // `defaultRole` only ever applies to the very first account, because sign-up is
      // refused once the user table has a row (see `src/auth/bootstrap.ts`). Everyone
      // after that is created from /admin/people with an explicit role. Removing that
      // gate without changing this line would make every new sign-up an owner.
      //
      // `roles` renames Better Auth's built-in "admin" role statement set to "owner",
      // reusing its permissions verbatim. Without it, `adminRoles: ["owner"]` throws at
      // construction time: the admin plugin only accepts role names it already knows.
      // This is Better Auth's own access-control layer for its /admin/* routes, separate
      // from `src/auth/policy.ts`, which is what the rest of ForgePod checks against.
      admin({ defaultRole: "owner", adminRoles: ["owner"], roles: { owner: adminAc } }),
      // `enableSessionForAPIKeys` stays off. It mocks a session for the key's owner,
      // which would let a key handed to an outside system call /api-key/create and change
      // the owner's password. `src/auth/actor.ts` verifies keys explicitly instead.
      apiKey(),
    ],
  });
}

let instance: Promise<ReturnType<typeof createAuth>> | undefined;

/**
 * Opened once per process, with Better Auth's own migrations run on the way, so nothing
 * else has to remember to. Mirrors `database()` in `src/db/index.ts` deliberately.
 *
 * The dependency points one way: this file imports `src/db`, and `src/db` never imports
 * this one. Running these migrations inside `database()` would close that into a cycle.
 */
export function auth(): Promise<ReturnType<typeof createAuth>> {
  instance ??= (async () => {
    const url = databaseUrl();
    const type = url.startsWith("postgres://") || url.startsWith("postgresql://") ? "postgres" : "sqlite";
    const created = createAuth(await database(), type);

    // Not "better-auth/db": in 1.7.2 that entry point re-exports @better-auth/core/db and
    // does not carry getMigrations. It lives at this subpath instead.
    const { getMigrations } = await import("better-auth/db/migration");
    await (await getMigrations(created.options)).runMigrations();

    return created;
  })();
  return instance;
}
