import { expect, test } from "bun:test";

/**
 * The web framework is a delivery shell, and this test is what keeps it one. Product
 * logic that never imports Next can be served by something else later without being
 * rewritten, and logic that avoids runtime-specific globals can run outside Bun.
 *
 * If this fails, the fix is to move the offending code into `app/`, not to widen the
 * test.
 */
test("core carries no framework import and no runtime-specific global", async () => {
  const offenders: string[] = [];

  for await (const path of new Bun.Glob("src/**/*.ts").scan(".")) {
    if (path.endsWith(".test.ts")) continue;
    const source = await Bun.file(path).text();

    if (/from ["']next(\/|["'])/.test(source)) offenders.push(`${path}: imports next`);
    if (/\bBun\./.test(source)) offenders.push(`${path}: uses a Bun global`);
  }

  expect(offenders).toEqual([]);
});
