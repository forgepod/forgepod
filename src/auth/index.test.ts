import { expect, test } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../db/bun-sqlite";
import type { Schema } from "../db/schema";
import { authSecret, createAuth } from "./index";

test("a missing secret refuses to boot and names the variable", () => {
  expect(() => authSecret({})).toThrow(/BETTER_AUTH_SECRET/);
  expect(() => authSecret({ BETTER_AUTH_SECRET: "   " })).toThrow(/BETTER_AUTH_SECRET/);
  expect(authSecret({ BETTER_AUTH_SECRET: "s3cret" })).toBe("s3cret");
});

test("better auth creates its own tables on the connection it was handed", async () => {
  const db = new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });
  try {
    const instance = createAuth(db, "sqlite", { BETTER_AUTH_SECRET: "s3cret" });
    // Not "better-auth/db": in 1.7.2 that entry point does not carry getMigrations.
    const { getMigrations } = await import("better-auth/db/migration");
    await (await getMigrations(instance.options)).runMigrations();

    const tables = (await db.introspection.getTables()).map((t) => t.name);
    expect(tables).toContain("user");
    expect(tables).toContain("session");
    expect(tables).toContain("apikey");
  } finally {
    await db.destroy();
  }
});
