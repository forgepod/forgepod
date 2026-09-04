import { database } from "../db";
import { auth } from "./index";
import { can, isRole, type Action, type Actor, type Resource } from "./policy";

/**
 * Two ways to carry a credential, one kind of actor. A browser sends the session cookie,
 * an outside system sends `x-api-key`.
 *
 * The key is verified through its own endpoint rather than by turning on
 * `enableSessionForAPIKeys`. That option mocks a full session for the key's owner, so a
 * key given to a third party would also reach `/api-key/create` and the password change
 * endpoint. Verifying explicitly costs one branch and grants exactly one thing.
 */
export async function actorFrom(headers: Headers): Promise<Actor | null> {
  const instance = await auth();

  const presented = headers.get("x-api-key");
  if (presented) {
    const result = await instance.api.verifyApiKey({ body: { key: presented } });
    // `verifyApiKey` never throws on a bad key, it answers `{ valid: false, key: null }`.
    // `key` carries the row's ownership as `referenceId` (the api-key plugin's own name
    // for it, not `userId`), because the same column also holds an organization id when
    // a deployment configures `references: "organization"`. This one does not.
    if (!result.valid || !result.key) return null;
    return roleOf(result.key.referenceId);
  }

  const session = await instance.api.getSession({ headers });
  if (!session?.user) return null;
  return roleOf(session.user.id);
}

/**
 * Read from the row rather than from the session, because a session issued before a
 * demotion still carries the old role, and the whole point of a role is that changing it
 * takes effect.
 */
async function roleOf(userId: string): Promise<Actor | null> {
  const db = await database();
  // Better Auth owns the `user` table and it is deliberately absent from `Schema`;
  // adding it there would duplicate a schema this repo has decided not to own.
  const row = (await db
    .selectFrom("user" as never)
    .select(["id", "role", "banned"] as never)
    .where("id" as never, "=", userId as never)
    .executeTakeFirst()) as { id: string; role: string | null; banned: boolean | number | null } | undefined;

  if (!row) return null;
  // SQLite has no boolean type, so `banned` comes back as 0 or 1 as often as it comes
  // back as a real boolean. Truthiness reads both.
  if (row.banned) return null;
  if (!row.role || !isRole(row.role)) return null;

  return { userId: row.id, role: row.role };
}

export type Verdict = { ok: true; actor: Actor } | { ok: false; reason: string; status: 401 | 403 };

/**
 * The single call every server action and route handler makes on its first line.
 * `src/auth/entrypoints.test.ts` fails if one of them does not.
 *
 * It returns a verdict rather than throwing, because a server action that throws replaces
 * the page with an error screen the operator cannot act on. That is the same reason
 * `bindHookAction` already carries its failure back in the URL.
 */
export async function guard(headers: Headers, action: Action, resource?: Resource): Promise<Verdict> {
  const actor = await actorFrom(headers);
  if (!actor) return { ok: false, reason: "Sign in to do that.", status: 401 };
  if (!can(actor, action, resource)) {
    return { ok: false, reason: `A ${actor.role} cannot ${action}.`, status: 403 };
  }
  return { ok: true, actor };
}
