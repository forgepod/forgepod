// setRoleAction reaches the process-wide auth() and database() memos, and both read
// process.env when they are first called rather than when this file is imported. Setting
// them here is what keeps this test off the real forgepod.db. Bun gives each test file its
// own process, so it cannot leak into another file's run.
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.FORGEPOD_DATABASE_URL ??= "file::memory:";

import { expect, mock, test } from "bun:test";
import { applySetCookies } from "better-auth/cookies";
import { auth } from "@/auth";
import { database } from "@/db";

// `setRoleAction` calls the real `headers()` from "next/headers", which throws outside an
// actual Next request (there is no work store for it to read). Mocking it to hand back a
// real signed-in session is what lets this test drive the exported action itself, not a
// copy of its logic, so a regression in the action is what turns this test red.
let activeHeaders = new Headers();
mock.module("next/headers", () => ({ headers: async () => activeHeaders }));

const { setRoleAction } = await import("./actions");

async function signUpOwner(email: string): Promise<{ id: string; headers: Headers }> {
  const instance = await auth();
  const { headers: setHeaders, response } = await instance.api.signUpEmail({
    body: { email, password: "correct-horse-battery-x", name: "Owner" },
    returnHeaders: true,
  });
  const cookieHeaders = new Headers();
  applySetCookies(cookieHeaders, setHeaders.getSetCookie());
  return { id: (response as { user: { id: string } }).user.id, headers: cookieHeaders };
}

async function roleOf(userId: string): Promise<string | undefined> {
  const db = await database();
  const row = (await db
    .selectFrom("user" as never)
    .select(["role"] as never)
    .where("id" as never, "=", userId as never)
    .executeTakeFirst()) as { role: string } | undefined;
  return row?.role;
}

/**
 * `redirect()` works by throwing an `Error` whose `digest` encodes
 * `NEXT_REDIRECT;<type>;<url>;<status>;`. `encodeURIComponent` escapes `;`, so the url
 * segment itself never contains one, and this can split on it safely.
 */
function redirectQuery(e: unknown, key: string): string | null {
  const digest = (e as { digest?: string }).digest;
  if (!digest?.startsWith("NEXT_REDIRECT;")) throw e;
  const url = digest.split(";").slice(2, -2).join(";");
  return new URL(url, "http://test").searchParams.get(key);
}

test("an owner cannot set their own role", async () => {
  const owner = await signUpOwner("self-demote@example.com");
  activeHeaders = owner.headers;

  const form = new FormData();
  form.set("userId", owner.id);
  form.set("role", "editor");

  let error: string | null = null;
  try {
    await setRoleAction(form);
    throw new Error("expected setRoleAction to redirect");
  } catch (e) {
    error = redirectQuery(e, "error");
  }

  expect(error).toMatch(/cannot change your own role/i);
  expect(await roleOf(owner.id)).toBe("owner");
});
