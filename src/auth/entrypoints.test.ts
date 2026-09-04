import { expect, test } from "bun:test";

/**
 * Permission is enforced at the shell, which means a new server action or route handler
 * is one forgotten line away from being open. This is that line, made mandatory.
 *
 * It is the same shape as `src/boundary.test.ts`: scan the files, list the offenders,
 * expect the list to be empty. If it fails, add the guard. Do not widen the test.
 *
 * What it cannot see: whether the guard was called with the right action, or whether the
 * verdict it returned was actually checked. Nothing in this repo covers that today.
 * `policy.test.ts` only unit-tests the pure `can()` matrix; it never exercises a caller
 * that calls `guard()` and then ignores `verdict.ok`.
 *
 * The count is a proxy for coverage, not proof of it: a file can satisfy
 * `guards >= entryPoints` with two `guard(` calls while one verb path stays open, for
 * example a shared handler exported as both GET and POST where only one branch checks.
 * Closing that properly needs AST analysis, which is a bigger machine than this hole
 * justifies, so it stays a known limit instead of a fixed one.
 *
 * A `"use server"` function in a file that is not `actions.ts` or `route.ts` is invisible
 * to the glob. `app/masthead.tsx` holds exactly such a function, `signOutAction`,
 * deliberately unguarded because signing out cannot require permission, and it never
 * reaches this scanner regardless.
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

// Whole-line comments only: a `//` that is the first non-whitespace character on its
// line. Stripping anything after an inline `//` would also eat a real call sitting past
// a string literal that happens to contain `//`, such as a URL, so that case is left
// alone rather than risk a false offender on correct code.
function stripComments(source: string): string {
  return source
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

test("every server action and route handler asks permission first", async () => {
  const offenders: string[] = [];

  const patterns = ["app/**/actions.ts", "app/api/**/route.ts"];
  for (const pattern of patterns) {
    for await (const path of new Bun.Glob(pattern).scan(".")) {
      if (skip.has(path)) continue;
      if ([...skipPrefixes.keys()].some((prefix) => path.startsWith(prefix))) continue;

      const source = await Bun.file(path).text();

      // Three shapes reach the outside world: a server action written as
      // `export async function`, one written as `export const name = async` (typed or
      // not), and a route handler sometimes exported as
      // `export { handler as GET, handler as POST }`. The last pattern matches each verb
      // rather than the export statement, because one statement can publish several
      // handlers and matching the statement counts one.
      const entryPoints = [
        ...source.matchAll(/export async function (\w+)/g),
        ...source.matchAll(/export const (\w+)(?:\s*:\s*[^\n]+?)?\s*=\s*async\b/g),
        ...source.matchAll(/\bas (GET|POST|PUT|PATCH|DELETE)\b/g),
      ].map((m) => m[1]);

      if (entryPoints.length === 0) continue;

      // Count rather than merely look for one call: a single guard in a file with five
      // actions still leaves four of them open. `guard(` also matches the import line's
      // `guard` identifier, but that line has no opening parenthesis after it, so the
      // regex, which requires one, does not count it. Comments are stripped first so a
      // commented-out `guard(...)` cannot inflate the count.
      const guards = stripComments(source).match(/\bguard\(/g)?.length ?? 0;
      if (guards < entryPoints.length) {
        offenders.push(
          `${path}: ${entryPoints.length} entry points (${entryPoints.join(", ")}), ${guards} guard() calls`,
        );
      }
    }
  }

  expect(offenders).toEqual([]);
});
