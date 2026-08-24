import { expect, test } from "bun:test";

/**
 * The web framework is a delivery shell, and this test is what keeps it one. Product
 * logic that never imports Next can be served by something else later without being
 * rewritten.
 *
 * The runtime rule is narrower than it first looks. Its point is surviving framework
 * churn, not running everywhere, so a database driver is allowed to be runtime
 * specific: no SQLite binding works on both Bun and Node today. That exception is a
 * list of exactly one file, and it stays that way.
 *
 * If this fails, move the offending code behind the shell or into a driver. Do not
 * widen the test.
 */
const runtimeSpecific = new Set(["src/db/bun-sqlite.ts"]);

test("core carries no framework, and runtime-specific code lives only in a driver", async () => {
  const offenders: string[] = [];

  for await (const path of new Bun.Glob("src/**/*.ts").scan(".")) {
    if (path.endsWith(".test.ts")) continue;
    const source = await Bun.file(path).text();

    if (/from ["']next(\/|["'])/.test(source)) offenders.push(`${path}: imports next`);
    if (runtimeSpecific.has(path)) continue;
    if (/\bBun\./.test(source)) offenders.push(`${path}: uses a Bun global`);
    if (/from ["']bun:/.test(source)) offenders.push(`${path}: imports a bun: module`);
  }

  expect(offenders).toEqual([]);
});
