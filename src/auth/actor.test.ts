// actorFrom reaches the process-wide auth() and database() memos, so this file has to
// decide what they resolve to before anything imports them. Bun gives each test file its
// own process, so setting them here cannot leak into another file's run.
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.FORGEPOD_DATABASE_URL ??= "file::memory:";

import { expect, test } from "bun:test";
import { actorFrom, guard } from "./actor";

// The signed-in and API-key cases need an account to exist, and accounts arrive with the
// sign-up route in the next task. They are tested in `src/auth/bootstrap.test.ts`.

test("no credentials means no actor", async () => {
  expect(await actorFrom(new Headers())).toBeNull();
});

test("a guard with no actor refuses with 401, not 403", async () => {
  const verdict = await guard(new Headers(), "agent.run");
  expect(verdict.ok).toBe(false);
  if (!verdict.ok) expect(verdict.status).toBe(401);
});
