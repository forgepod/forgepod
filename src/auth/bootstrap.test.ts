import { expect, test } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../db/bun-sqlite";
import { migrate } from "../db/migrate";
import type { Schema } from "../db/schema";
import { createAuth } from "./index";
import { hasAnyUser } from "./bootstrap";

const env = { BETTER_AUTH_SECRET: "s3cret" };

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
