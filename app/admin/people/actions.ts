"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { database } from "@/db";
import { auth } from "@/auth";
import { guard } from "@/auth/actor";
import type { Role } from "@/auth/policy";

const CREATABLE_ROLES: readonly Role[] = ["editor", "runner"];

function fail(message: string): never {
  redirect(`/admin/people?error=${encodeURIComponent(message)}`);
}

/**
 * Owner only, and the role a form here can hand out stops at editor and runner. A
 * second owner is not creatable from this form on purpose: promoting someone to owner
 * is a separate, deliberate act, and `setRoleAction` below is the endpoint for it once
 * it is actually wanted.
 */
export async function createPersonAction(form: FormData): Promise<void> {
  const verdict = await guard(await headers(), "user.manage");
  if (!verdict.ok) redirect(`/admin/people?error=${encodeURIComponent(verdict.reason)}`);

  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const name = String(form.get("name") ?? "").trim();
  const role = String(form.get("role") ?? "");

  if (!CREATABLE_ROLES.includes(role as Role)) {
    fail("Pick editor or runner. A second owner is a separate, deliberate act.");
  }

  try {
    await (await auth()).api.createUser({
      body: { email, password, name, role: role as Role },
      headers: await headers(),
    });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }

  redirect("/admin/people");
}

/**
 * The one place a second owner can actually be minted, and the one place the last owner
 * can be stopped from locking everyone out. Refusing a change to the acting owner's own
 * id is what keeps this install always administrable by someone.
 *
 * `selfTargetGate` in `src/auth/bootstrap.ts` is the real gate: it sits in front of
 * Better Auth's own `/admin/set-role`, the mounted route this action's own call to
 * `auth().api.setRole` also passes through, so it already refuses this case. The check
 * below stays anyway as defence in depth, in case that middleware is ever loosened.
 */
export async function setRoleAction(form: FormData): Promise<void> {
  const verdict = await guard(await headers(), "user.manage");
  if (!verdict.ok) redirect(`/admin/people?error=${encodeURIComponent(verdict.reason)}`);

  const userId = String(form.get("userId") ?? "");
  const role = String(form.get("role") ?? "");

  if (userId === verdict.actor.userId) {
    fail("You cannot change your own role. Have another owner do it, or this install could end up with nobody able to administer it.");
  }

  try {
    await (await auth()).api.setRole({ body: { userId, role: role as Role }, headers: await headers() });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }

  redirect("/admin/people");
}

export type IssueKeyState = { key: string | null; error: string | null };

/**
 * Returns state instead of redirecting, and never puts the plaintext key in a URL. A
 * query string lands in the browser's address bar, session history, the `Location`
 * header, and every access log and reverse proxy line in front of this app, and none of
 * that clears on reload, so "shown once" would already be a lie the moment it got there.
 * The caller is `<IssueKeyForm>` in `./issue-key-form.tsx`, a client component wired
 * through `useActionState`, which keeps the returned key in React state and nowhere
 * else, so a reload genuinely does lose it.
 *
 * Called without headers on purpose. Better Auth's own `/api-key/create`, read in
 * `node_modules/@better-auth/api-key/dist/index.mjs`, ignores `body.userId` entirely
 * the moment it sees a session on the request (which passing headers here would
 * produce) and issues the key to the caller's own account instead. Only the
 * header-less, server-only branch honours an explicit `userId`. `guard` above is the
 * real authorization for this action; Better Auth is only asked to mint the row.
 *
 * That header-less path also skips every check Better Auth would otherwise run on the
 * target id, so a bad id would mint a key row pointing at nobody. Checked here instead.
 */
export async function issueKeyAction(_prevState: IssueKeyState, form: FormData): Promise<IssueKeyState> {
  const verdict = await guard(await headers(), "user.manage");
  if (!verdict.ok) return { key: null, error: verdict.reason };

  const userId = String(form.get("userId") ?? "");
  const name = String(form.get("name") ?? "").trim() || undefined;

  const db = await database();
  const person = await db
    .selectFrom("user" as never)
    .select(["id"] as never)
    .where("id" as never, "=", userId as never)
    .executeTakeFirst();
  if (!person) return { key: null, error: "No such person." };

  try {
    const result = await (await auth()).api.createApiKey({ body: { userId, name } });
    return { key: result.key, error: null };
  } catch (e) {
    return { key: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A direct delete on Better Auth's own `apikey` table rather than
 * `auth().api.deleteApiKey`. That endpoint requires a session and, per the same source
 * file above, refuses unless `apiKey.referenceId` equals the caller's own id, so an
 * owner revoking someone else's key gets a 404 no matter what: there is no admin
 * override in the plugin. `guard` above already establishes the caller is an owner, so
 * this reaches straight into the table the same way `src/auth/actor.ts` and
 * `src/auth/bootstrap.ts` already read `user` directly rather than only through
 * Better Auth's own endpoints.
 */
export async function revokeKeyAction(form: FormData): Promise<void> {
  const verdict = await guard(await headers(), "user.manage");
  if (!verdict.ok) redirect(`/admin/people?error=${encodeURIComponent(verdict.reason)}`);

  const keyId = String(form.get("keyId") ?? "");
  const db = await database();
  const result = (await db
    .deleteFrom("apikey" as never)
    .where("id" as never, "=", keyId as never)
    .executeTakeFirst()) as { numDeletedRows: bigint } | undefined;

  if (!result || result.numDeletedRows === 0n) {
    fail("No such key.");
  }

  redirect("/admin/people");
}
