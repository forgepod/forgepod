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

test("a user row with no role assigned falls back to the least privileged role", async () => {
  const db = new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });
  try {
    const instance = createAuth(db, "sqlite", { BETTER_AUTH_SECRET: "s3cret" });
    // Reaches into Better Auth's own plugin config, which is not typed for external use.
    const adminPlugin = instance.options.plugins?.find((p: any) => p.id === "admin") as any;

    expect(adminPlugin.options.defaultRole).toBe("runner");

    // The fallback role must be unable to do anything through Better Auth's own
    // admin access control, using Better Auth's own authorize function rather than a
    // reimplementation of it.
    const fallbackRole = adminPlugin.options.roles.runner;
    expect(fallbackRole.authorize({ user: ["ban"] }).success).toBe(false);
    expect(fallbackRole.authorize({ session: ["revoke"] }).success).toBe(false);
  } finally {
    await db.destroy();
  }
});
