import { createAuthMiddleware, APIError, getSessionFromCtx } from "better-auth/api";
import type { Kysely } from "kysely";
import type { Schema } from "../db/schema";

/**
 * Better Auth owns the `user` table, so it is not in `Schema` and the cast says so.
 *
 * This is a live check, not a one-time flag, so deleting the last user row reopens the
 * install for claiming by anyone who reaches it next. That follows from what this
 * function actually asks; it is not a special case anywhere.
 */
export async function hasAnyUser(db: Kysely<Schema>): Promise<boolean> {
  const row = await db
    .selectFrom("user" as never)
    .select(["id"] as never)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Open sign-up exists for exactly one account: the one that turns a fresh install into an
 * owned one. Leaving it open past that would let anyone who can reach the install create
 * themselves an account, and `claimOwnership` would make it an owner.
 *
 * Two sign-ups arriving at once could both pass `hasAnyUser` before either row lands, so
 * both would slip through this gate. Not locked: whoever reaches an unclaimed install
 * first wins either way, lock or no lock, since there is nothing yet to steal from. The
 * only thing a race costs is two owners instead of one, which an owner can fix from the
 * people page afterward. Not worth a lock for that.
 */
export function signUpGate(db: Kysely<Schema>) {
  return createAuthMiddleware(async (ctx) => {
    if (ctx.path !== "/sign-up/email") return;
    if (await hasAnyUser(db)) {
      throw new APIError("FORBIDDEN", {
        message: "This install already has an account. Ask its owner to add you from the people page.",
      });
    }
  });
}

/**
 * Better Auth mounts `/api-key/*` itself, a second permission surface `src/auth/policy.ts`
 * never reaches. Its own `/api-key/create` honours a signed-in session on the branch
 * reached whenever `ctx.request || ctx.headers` is set (verified against
 * `node_modules/@better-auth/api-key/dist/index.mjs`), and issues the key to the caller's
 * own account with no role check attached: any runner or editor can mint a live key for
 * themselves that `guard()` in `src/auth/actor.ts` then treats as a legitimate credential.
 * The design makes issuing keys owner-only; `app/admin/people/actions.ts` enforces that,
 * this mounted route did not.
 *
 * Gated for every `/api-key/` path, not only `/api-key/create`: ForgePod has no
 * legitimate caller for any of them over HTTP. `issueKeyAction` mints through the
 * header-less server branch (see its own comment in `app/admin/people/actions.ts`), and
 * the people page reads and deletes the `apikey` table directly, because `/api-key/list`
 * and `/api-key/delete` only ever scope to the caller's own session id, not the admin
 * view that page needs. Leaving `/api-key/list` or `/api-key/get` open to a session
 * cookie would still let a signed-in person enumerate their own key metadata for a
 * feature this app never offers, so the whole client branch is refused rather than
 * picking just the mutating routes.
 *
 * The header-less server call `issueKeyAction` makes carries neither `ctx.request` nor
 * `ctx.headers`, so it passes through untouched, the same distinction the plugin itself
 * uses to decide `isClientRequest`.
 */
export function apiKeyMintGate() {
  return createAuthMiddleware(async (ctx) => {
    if (!ctx.path.startsWith("/api-key/")) return;
    if (ctx.request || ctx.headers) {
      throw new APIError("FORBIDDEN", {
        message: "API keys are issued from the people page, not this endpoint.",
      });
    }
  });
}

/**
 * Refusal per route, keyed by `ctx.path`. Each one names what was attempted rather than
 * sharing one generic string, since an owner hitting this needs to know which action was
 * refused.
 */
const SELF_TARGET_REFUSAL: Record<string, string> = {
  "/admin/set-role":
    "You cannot change your own role. Have another owner do it, or this install could end up with nobody able to administer it.",
  "/admin/ban-user":
    "You cannot ban yourself. There is no unban control in this app yet, so that would lock you out with no way back in.",
  "/admin/remove-user":
    "You cannot remove yourself. Deleting the last account reopens sign-up to whoever reaches this install next.",
};

/**
 * `/admin/set-role`, `/admin/ban-user`, and `/admin/remove-user` are Better Auth's own
 * mounted routes, a second surface `app/admin/people/actions.ts` cannot reach (there is
 * no action for the latter two yet, so a direct POST is the only way to them today). A
 * self-target on any of the three can strand the install:
 *
 * - `/admin/set-role`: on a single-owner install, nothing can grant `user.manage` again
 *   afterward. This does not reopen claiming, unlike the other two.
 * - `/admin/ban-user`: `roleOf` in `src/auth/actor.ts` returns null for a banned row, and
 *   there is no unban control anywhere in this app, so a self-ban has no way back.
 * - `/admin/remove-user`: deleting the last user makes `hasAnyUser` false, which reopens
 *   sign-up, so the install goes back to being claimable by whoever reaches it next.
 *
 * Better Auth's own handlers for `/admin/ban-user` and `/admin/remove-user` already
 * refuse a self-target ("You cannot ban yourself" / "You cannot remove yourself";
 * confirmed against `node_modules/better-auth/dist/plugins/admin/routes.mjs` and by a
 * live call through this app's own `auth()`), unlike `/admin/set-role`, which has no
 * such check at all. All three are gated here anyway: this hook runs before Better
 * Auth's own middleware even resolves the target, so the two that are already covered
 * get an earlier, ForgePod-owned refusal instead of depending on a check pinned to one
 * version of a third-party plugin. All three routes name the target with the same body
 * field, `userId` (confirmed against the same source file).
 *
 * This hook runs before the admin plugin's own `adminMiddleware`, so the acting session
 * is not yet on `ctx.context.session` and is read with `getSessionFromCtx` instead, the
 * same helper `@better-auth/api-key` uses for the same reason.
 *
 * Because this middleware also runs for `setRoleAction`'s own call to `auth().api.setRole`,
 * this one gate covers both the mounted route and the server action, which makes the
 * check already in `setRoleAction` redundant. That check stays anyway as defence in
 * depth, with a comment saying this middleware is the real gate.
 */
export function selfTargetGate() {
  return createAuthMiddleware(async (ctx) => {
    const refusal = SELF_TARGET_REFUSAL[ctx.path];
    if (!refusal) return;
    const session = await getSessionFromCtx(ctx);
    if (!session?.user) return;
    if (ctx.body?.userId === session.user.id) {
      throw new APIError("FORBIDDEN", { message: refusal });
    }
  });
}

/**
 * `hooks.before` takes exactly one `AuthMiddleware`, so every before-hook this install
 * needs runs through this single composed one. Order does not matter between these
 * three: each checks its own `ctx.path` first and returns immediately for every other
 * endpoint.
 */
export function authGate(db: Kysely<Schema>) {
  const signUp = signUpGate(db);
  const apiKey = apiKeyMintGate();
  const selfTarget = selfTargetGate();
  return createAuthMiddleware(async (ctx) => {
    await signUp(ctx);
    await apiKey(ctx);
    await selfTarget(ctx);
  });
}

/**
 * The first account owns the install. `defaultRole` cannot do this: Better Auth also uses
 * it as the fallback for any row whose role column is empty, so setting it to `owner`
 * would make an unset role the most privileged one rather than the least.
 *
 * Paired with `signUpGate`, which is what guarantees "the first account" is a category with
 * exactly one member. Neither is safe without the other.
 */
export function claimOwnership(db: Kysely<Schema>) {
  return {
    user: {
      create: {
        before: async (user: Record<string, unknown>) => {
          if (await hasAnyUser(db)) return;
          return { data: { ...user, role: "owner" } };
        },
      },
    },
  };
}
