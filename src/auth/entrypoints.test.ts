import { expect, test } from "bun:test";

/**
 * Permission is enforced at the shell, which means a new server action or route handler
 * is one forgotten line away from being open. This is that line, made mandatory.
 *
 * It is the same shape as `src/boundary.test.ts`: scan the files, list the offenders,
 * expect the list to be empty. If it fails, add the guard. Do not widen the test.
 *
 * What it cannot see: whether the guard was called with the right action. That is what
 * `policy.test.ts` covers, from the other side.
 *
 * The brief scanned `app/admin/**\/actions.ts`, but a server action can exist outside
 * `app/admin/` (`app/login/actions.ts` already does), so this scans every `actions.ts`
 * and `route.ts` in the app instead. Anything that must stay open is named below, with a
 * reason, rather than carved out by a glob nobody reads.
 */
const skip = new Map<string, string>([
  ["app/login/actions.ts", "signing in cannot require being signed in"],
]);
const skipPrefixes = new Map<string, string>([
  ["app/api/auth/", "guarding Better Auth's own handler would lock everyone out of the install"],
]);

test("every server action and route handler asks permission first", async () => {
  const offenders: string[] = [];

  const patterns = ["app/**/actions.ts", "app/api/**/route.ts"];
  for (const pattern of patterns) {
    for await (const path of new Bun.Glob(pattern).scan(".")) {
      if (skip.has(path)) continue;
      if ([...skipPrefixes.keys()].some((prefix) => path.startsWith(prefix))) continue;

      const source = await Bun.file(path).text();

      // Two shapes reach the outside world: a server action is `export async function`,
      // and a route handler is sometimes `export { handler as GET, handler as POST }`.
      // The second pattern matches each verb rather than the export statement, because
      // one statement can publish several handlers and matching the statement counts one.
      const entryPoints = [
        ...source.matchAll(/export async function (\w+)/g),
        ...source.matchAll(/\bas (GET|POST|PUT|PATCH|DELETE)\b/g),
      ].map((m) => m[1]);

      if (entryPoints.length === 0) continue;

      // Count rather than merely look for one call: a single guard in a file with five
      // actions still leaves four of them open. `guard(` also matches the import line's
      // `guard` identifier, but that line has no opening parenthesis after it, so the
      // regex, which requires one, does not count it.
      const guards = source.match(/\bguard\(/g)?.length ?? 0;
      if (guards < entryPoints.length) {
        offenders.push(
          `${path}: ${entryPoints.length} entry points (${entryPoints.join(", ")}), ${guards} guard() calls`,
        );
      }
    }
  }

  expect(offenders).toEqual([]);
});
