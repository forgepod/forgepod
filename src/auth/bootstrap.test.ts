import { expect, test } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../db/bun-sqlite";
import { migrate } from "../db/migrate";
import type { Schema } from "../db/schema";
import { createAuth } from "./index";

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
    ).rejects.toThrow(/already/i);
  } finally {
    await db.destroy();
  }
});
