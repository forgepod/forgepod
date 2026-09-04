// `guard()` reaches the process-wide auth() and database() memos, and both read
// process.env when they are first called rather than when this file is imported. Setting
// them here is what keeps this test off the real forgepod.db. Bun gives each test file its
// own process, so it cannot leak into another file's run.
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.FORGEPOD_DATABASE_URL ??= "file::memory:";

import { expect, test } from "bun:test";
import { POST } from "./route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

test("an unauthenticated run is refused before the agent is even looked up", async () => {
  const response = await POST(
    new Request("http://localhost/api/agents/does-not-exist/run", {
      method: "POST",
      body: JSON.stringify({ input: "hello" }),
    }),
    ctx("does-not-exist"),
  );

  // 401 rather than 404: an open endpoint that answers "no such agent" tells an anonymous
  // caller which agent ids are real.
  expect(response.status).toBe(401);
});

test("a bad api key is refused too", async () => {
  const response = await POST(
    new Request("http://localhost/api/agents/does-not-exist/run", {
      method: "POST",
      headers: { "x-api-key": "not-a-real-key" },
      body: JSON.stringify({ input: "hello" }),
    }),
    ctx("does-not-exist"),
  );

  expect(response.status).toBe(401);
});
