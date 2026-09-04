"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies/utils";
import { auth } from "@/auth";

/**
 * A server action's return value is not a Response, so nothing carries Better Auth's
 * Set-Cookie header to the browser on its own. This is the same thing Better Auth's own
 * `nextCookies()` plugin does after every request, but that plugin lives at
 * `better-auth/next-js` and imports Next itself, which this repo never imports even from
 * an `app/` file that is otherwise free to. Copied out directly instead: it is a handful
 * of lines, and pulling in the whole plugin for them buys nothing.
 */
async function applySetCookie(headers: Headers | undefined): Promise<void> {
  const raw = headers?.get("set-cookie");
  if (!raw) return;
  const jar = await cookies();
  parseSetCookieHeader(raw).forEach((value, name) => {
    jar.set(name, value.value, toCookieOptions(value));
  });
}

async function complete(
  body: { email: string; password: string; name?: string },
  mode: "sign-up" | "sign-in",
): Promise<void> {
  const instance = await auth();
  let failure: string | null = null;

  try {
    const { headers } =
      mode === "sign-up"
        ? await instance.api.signUpEmail({
            body: body as { email: string; password: string; name: string },
            returnHeaders: true,
          })
        : await instance.api.signInEmail({ body, returnHeaders: true });
    await applySetCookie(headers);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  // redirect() works by throwing, so it stays outside the catch that would swallow it,
  // the same reason the admin actions in app/admin/agents/actions.ts keep it out too.
  redirect(failure ? `/login?error=${encodeURIComponent(failure)}` : "/admin/agents");
}

export async function claimAction(form: FormData): Promise<void> {
  await complete(
    {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      name: String(form.get("name") ?? ""),
    },
    "sign-up",
  );
}

export async function signInAction(form: FormData): Promise<void> {
  await complete(
    { email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") },
    "sign-in",
  );
}
