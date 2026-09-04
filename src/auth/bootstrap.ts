import { createAuthMiddleware, APIError } from "better-auth/api";
import type { Kysely } from "kysely";
import type { Schema } from "../db/schema";

/** Better Auth owns the `user` table, so it is not in `Schema` and the cast says so. */
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
 * both would slip through this gate. Not closed here: this product is set up once by
 * whoever runs the install command on a box nobody else can reach yet, so the race needs
 * a second person hitting the same fresh instance in the same instant before its first
 * account exists, which is not a realistic install path. Worth a lock the day this gate
 * guards something reachable before any operator is watching it.
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
