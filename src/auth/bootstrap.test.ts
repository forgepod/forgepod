// actorFrom and guard (tested below) reach the process-wide auth() and database() memos
// in src/auth/index.ts and src/db/index.ts, and both read process.env when first called
// rather than when this file is imported. Setting them here, before createAuth's own
// per-test instances even get used, is what keeps this file off the real forgepod.db.
// Bun gives each test file its own process, so this cannot leak into another file's run,
// the same reasoning src/auth/actor.test.ts already documents for the identical pattern.
process.env.BETTER_AUTH_SECRET ??= "s3cret";
process.env.FORGEPOD_DATABASE_URL ??= "file::memory:";

import { beforeAll, expect, test } from "bun:test";
import { Kysely } from "kysely";
import { parseSetCookieHeader } from "better-auth/cookies/utils";
import { BunSqliteDialect } from "../db/bun-sqlite";
import { migrate } from "../db/migrate";
import { database } from "../db";
import type { Schema } from "../db/schema";
import { createAuth, auth } from "./index";
import { hasAnyUser } from "./bootstrap";
import { actorFrom, guard } from "./actor";

const env = { BETTER_AUTH_SECRET: "s3cret" };

/** Turns a signIn/signUpEmail response's Set-Cookie into a Cookie header for the next call. */
function cookieHeaderFrom(headers: Headers | undefined): Headers {
  const raw = headers?.get("set-cookie");
  const parsed = raw ? parseSetCookieHeader(raw) : new Map();
  const cookie = [...parsed.entries()].map(([name, v]) => `${name}=${v.value}`).join("; ");
  return new Headers({ cookie });
}

async function freshAuth() {
  const db = new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });
  await migrate(db);
  const instance = createAuth(db, "sqlite", env);
  const { getMigrations } = await import("better-auth/db/migration");
  await (await getMigrations(instance.options)).runMigrations();
  return { db, instance };
}

test("the first account is created by whoever gets there first, and is an owner", async () => {
  const { db, instance } = await freshAuth();
  try {
    const created = await instance.api.signUpEmail({
      body: { email: "first@example.com", password: "correct-horse-battery", name: "First" },
    });
    expect(created.user.email).toBe("first@example.com");

    const row = (await db
      .selectFrom("user" as never)
      .select(["role"] as never)
      .executeTakeFirst()) as { role: string } | undefined;
    expect(row?.role).toBe("owner");
  } finally {
    await db.destroy();
  }
});

// Without this, anyone who can reach the install can mint themselves an owner account.
//
// Asserts on the gate's own wording, not just /already/i: Better Auth's built-in
// duplicate-email error also says "User already exists. Use another email.", which
// would let this test pass even if signUpGate never ran. The two test emails differ, so
// that error is not reachable today, but the assertion should not depend on staying
// lucky about that.
test("a second sign-up is refused once an account exists", async () => {
  const { db, instance } = await freshAuth();
  try {
    await instance.api.signUpEmail({
      body: { email: "first@example.com", password: "correct-horse-battery", name: "First" },
    });

    await expect(
      instance.api.signUpEmail({
        body: { email: "second@example.com", password: "correct-horse-battery", name: "Second" },
      }),
    ).rejects.toThrow(/already has an account/i);
  } finally {
    await db.destroy();
  }
});

// The browser's minLength is a hint, not a boundary. Without minPasswordLength set on
// the server, a direct POST to /api/auth/sign-up/email claims the owner account of a
// fresh install with an eight character password.
test("the server refuses a password shorter than 12 characters, not just the browser", async () => {
  const { db, instance } = await freshAuth();
  try {
    await expect(
      instance.api.signUpEmail({
        body: { email: "first@example.com", password: "short123", name: "First" },
      }),
    ).rejects.toThrow(/password/i);
    expect(await hasAnyUser(db)).toBe(false);
  } finally {
    await db.destroy();
  }
});

// The three tests below cover the credential lifecycle end to end: a key that works, a
// key whose owner is banned, and a role read fresh rather than cached. They share one
// account tree, set up once, because actorFrom and guard always reach the process-wide
// auth()/database() memo (see the process.env block above) rather than a db passed in,
// so this file gets exactly one first-and-only account to build on, the same limit
// signUpGate itself enforces.
let ownerCookie: Headers;
let keyHolderId: string;
let workingKey: string;
let bannedHolderId: string;
let bannedHolderKey: string;
let roleChangeUserId: string;
let roleChangeSessionCookie: Headers;

beforeAll(async () => {
  const instance = await auth();
  const db = await database();

  const signUp = await instance.api.signUpEmail({
    body: { email: "owner@lifecycle.test", password: "correct-horse-battery", name: "Owner" },
    returnHeaders: true,
  });
  ownerCookie = cookieHeaderFrom(signUp.headers);

  const keyHolder = await instance.api.createUser({
    body: { email: "keyholder@lifecycle.test", password: "correct-horse-battery", name: "Keyholder", role: "runner" },
    headers: ownerCookie,
  });
  keyHolderId = keyHolder.user.id;
  workingKey = (await instance.api.createApiKey({ body: { userId: keyHolderId, name: "lifecycle-valid" } })).key;

  const bannedHolder = await instance.api.createUser({
    body: { email: "banned@lifecycle.test", password: "correct-horse-battery", name: "Banned", role: "runner" },
    headers: ownerCookie,
  });
  bannedHolderId = bannedHolder.user.id;
  bannedHolderKey = (await instance.api.createApiKey({ body: { userId: bannedHolderId, name: "lifecycle-banned" } })).key;
  await db
    .updateTable("user" as never)
    .set({ banned: true } as never)
    .where("id" as never, "=", bannedHolderId as never)
    .execute();

  const roleChangeHolder = await instance.api.createUser({
    body: { email: "rolechange@lifecycle.test", password: "correct-horse-battery", name: "RoleChange", role: "owner" },
    headers: ownerCookie,
  });
  roleChangeUserId = roleChangeHolder.user.id;
  const signIn = await instance.api.signInEmail({
    body: { email: "rolechange@lifecycle.test", password: "correct-horse-battery" },
    returnHeaders: true,
  });
  roleChangeSessionCookie = cookieHeaderFrom(signIn.headers);
});

// This is the exact call app/api/agents/[id]/run/route.ts makes on its first line, before
// anything else runs. A verdict that is not a 401 or a 403 is what lets that route go on
// to look up the agent, so asserting `ok` here is asserting the run endpoint answers with
// something other than a refusal.
test("a valid API key authenticates: guard() for agent.run does not refuse with 401 or 403", async () => {
  const verdict = await guard(new Headers({ "x-api-key": workingKey }), "agent.run");
  expect(verdict.ok).toBe(true);
});

// Removing the `if (row.banned) return null;` line in src/auth/actor.ts's roleOf turns
// this red: see the final report for that run's output.
test("a key whose owner is banned resolves to no actor", async () => {
  const actor = await actorFrom(new Headers({ "x-api-key": bannedHolderKey }));
  expect(actor).toBeNull();
});

test("the role comes from the user row, not from the session, so a change after sign-in takes effect immediately", async () => {
  const before = await actorFrom(roleChangeSessionCookie);
  expect(before?.role).toBe("owner");

  const db = await database();
  await db
    .updateTable("user" as never)
    .set({ role: "runner" } as never)
    .where("id" as never, "=", roleChangeUserId as never)
    .execute();

  // Same session, not re-issued. If actorFrom read the role Better Auth cached on sign-in
  // instead of the row, this would still say "owner".
  const after = await actorFrom(roleChangeSessionCookie);
  expect(after?.role).toBe("runner");
});
