import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";
import { createAccessControl } from "better-auth/plugins/access";
import { apiKey } from "@better-auth/api-key";
import type { Kysely } from "kysely";
import { database, databaseUrl, typeFor } from "../db";
import type { Schema } from "../db/schema";
import { claimOwnership, signUpGate } from "./bootstrap";

const ac = createAccessControl(defaultStatements);

/**
 * Only "owner" holds Better Auth's own built-in admin statement set. "editor" and
 * "runner" are declared with no statements of their own: declaring them is what makes
 * `/admin/set-role` accept them as a target role (Better Auth refuses any role name
 * outside this map once the map is set), and holding nothing is what keeps them from
 * granting any of Better Auth's own admin powers. This is Better Auth's own
 * access-control layer for its /admin/* routes, separate from `src/auth/policy.ts`,
 * which is what the rest of ForgePod checks against.
 */
const roles = { owner: adminAc, editor: ac.newRole({}), runner: ac.newRole({}) };

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
    baseURL: env.BETTER_AUTH_URL,
    database: { db, type },
    // Better Auth's own default is 8. The owner account claims the whole install on a
    // fresh box, so its password floor is the login page's `minLength` too, not just
    // this server-side one the browser hint cannot be trusted to enforce alone.
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    hooks: { before: signUpGate(db) },
    databaseHooks: claimOwnership(db),
    plugins: [
      // `defaultRole` is what Better Auth falls back to whenever a user row's role
      // column is null or empty, and its own /admin/* middleware trusts that fallback
      // without checking anything else. It must be the least privileged role: "runner"
      // can do nothing through Better Auth's admin endpoints (see `roles` above), so a
      // row that never got a role assigned lands with no admin power instead of every
      // admin power. Sign-up still assigns a role explicitly (see
      // `src/auth/bootstrap.ts`); this is the floor for whatever slips past that.
      admin({ defaultRole: "runner", adminRoles: ["owner"], roles }),
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
 * else has to remember to. Mirrors `database()` in `src/db/index.ts` deliberately,
 * including the same failure handling: `??=` alone would cache a rejected promise
 * forever, since a rejection is not nullish, so a transient failure here (or a
 * non-transient one from `getMigrations`) would leave `auth()` refusing for the rest of
 * the process instead of retrying on the next call.
 *
 * The dependency points one way: this file imports `src/db`, and `src/db` never imports
 * this one. Running these migrations inside `database()` would close that into a cycle.
 */
export function auth(): Promise<ReturnType<typeof createAuth>> {
  instance ??= (async () => {
    // Checked before opening the database, so a missing secret refuses immediately
    // instead of paying for a full database open and migration first.
    authSecret();

    const url = databaseUrl();
    const created = createAuth(await database(), typeFor(url));

    // Not "better-auth/db": in 1.7.2 that entry point re-exports @better-auth/core/db and
    // does not carry getMigrations. It lives at this subpath instead.
    const { getMigrations } = await import("better-auth/db/migration");
    await (await getMigrations(created.options)).runMigrations();

    return created;
  })().catch((err) => {
    instance = undefined;
    throw err;
  });
  return instance;
}
