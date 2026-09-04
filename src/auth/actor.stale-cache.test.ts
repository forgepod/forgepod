// actorFrom is mocked to a session-cache-enabled instance below, so it must be re-imported
// after the mock is registered, not pulled in at the top of the file the usual way. Bun
// gives each test file its own process, so mocking "./index" here cannot reach any other
// file's own auth() singleton (the same reasoning app/admin/people/actions.test.ts already
// documents for mocking "next/headers").
process.env.BETTER_AUTH_SECRET ??= "s3cret";
process.env.FORGEPOD_DATABASE_URL ??= "file::memory:";

import { expect, mock, test } from "bun:test";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";
import { createAccessControl } from "better-auth/plugins/access";
import { parseSetCookieHeader } from "better-auth/cookies/utils";
import type { Kysely } from "kysely";
import type { Schema } from "../db/schema";
import { database } from "../db";
import { authGate, claimOwnership } from "./bootstrap";

const ac = createAccessControl(defaultStatements);
const roles = { owner: adminAc, editor: ac.newRole({}), runner: ac.newRole({}) };

/**
 * A plain function rather than an inline object literal at the assignment site: typing
 * `testInstance` as this function's return type (below) is what keeps the plugin and
 * session config on the type, which is what makes `session.user.role` and `db`'s exact
 * shape resolve instead of widening to Better Auth's generic `Auth<BetterAuthOptions>`.
 */
function buildTestInstance(db: Kysely<Schema>) {
  return betterAuth({
    secret: "s3cret",
    database: { db, type: "sqlite" },
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    session: { cookieCache: { enabled: true, maxAge: 60 } },
    hooks: { before: authGate(db) },
    databaseHooks: claimOwnership(db),
    plugins: [admin({ defaultRole: "runner", adminRoles: ["owner"], roles })],
  });
}

let testInstance: ReturnType<typeof buildTestInstance>;
mock.module("./index", () => ({ auth: async () => testInstance }));

const { actorFrom } = await import("./actor");

/** Same shape cookieHeaderFrom uses elsewhere: a signIn/signUpEmail Set-Cookie back as a request Cookie header. */
function cookieHeaderFrom(headers: Headers | undefined): Headers {
  const raw = headers?.get("set-cookie");
  const parsed = raw ? parseSetCookieHeader(raw) : new Map();
  return new Headers({ cookie: [...parsed.entries()].map(([name, v]) => `${name}=${v.value}`).join("; ") });
}

// Production never turns cookieCache on: src/auth/index.ts's createAuth has no session
// config at all. It goes on here, on a one-off instance built just for this file, because
// it is the one condition that makes Better Auth answer getSession from a signed cookie
// instead of the user row, which is the exact staleness actorFrom's own comment says
// roleOf exists to avoid. Without it, every getSession call joins the row fresh regardless
// of where the caller reads the role from, and a test asserting "read from the row, not
// the session" cannot tell the two implementations apart.
test("a demotion outlives the session's own cache: actorFrom has to hit the row, not the cached cookie", async () => {
  const db = await database();

  testInstance = buildTestInstance(db);
  const { getMigrations } = await import("better-auth/db/migration");
  await (await getMigrations(testInstance.options)).runMigrations();

  const signUp = await testInstance.api.signUpEmail({
    body: { email: "cache-owner@example.com", password: "correct-horse-battery", name: "Owner" },
    returnHeaders: true,
  });
  const cookie = cookieHeaderFrom(signUp.headers);
  const userId = (signUp.response as { user: { id: string } }).user.id;

  const before = await actorFrom(cookie);
  expect(before?.role).toBe("owner");

  await db
    .updateTable("user" as never)
    .set({ role: "runner" } as never)
    .where("id" as never, "=", userId as never)
    .execute();

  // Proves the cache is really what would go stale, not just that this test is set up
  // wrong: Better Auth's own getSession, same cookie, still answers "owner".
  const cached = await testInstance.api.getSession({ headers: cookie });
  expect(cached?.user.role).toBe("owner");

  // actorFrom must not be fooled by that. Same session, not re-issued.
  const after = await actorFrom(cookie);
  expect(after?.role).toBe("runner");
});
