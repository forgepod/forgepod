import { cookies } from "next/headers";
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies/utils";

/**
 * A server action's return value is not a Response, so nothing carries Better Auth's
 * Set-Cookie header to the browser on its own. This is the same thing Better Auth's own
 * `nextCookies()` plugin does after every request, but that plugin lives at
 * `better-auth/next-js` and imports Next itself, which this repo never imports even from
 * an `app/` file that is otherwise free to. Copied out directly instead: it is a handful
 * of lines, and pulling in the whole plugin for them buys nothing.
 *
 * Lives in its own plain module rather than a `"use server"` file. A function exported
 * from a `"use server"` file is a public server action endpoint, and this one's only job
 * is writing cookies from a `Headers` argument nothing can construct over the wire today.
 * That is not exploitable now (React's decoder cannot rebuild a `Headers` argument, so a
 * call throws before this ever runs), but `app/login/actions.ts` sat on the entry point
 * scanner's skip list for an unrelated reason, so a change to that scanner would never
 * have flagged it. Moving it here removes the question rather than relying on the throw.
 */
export async function applySetCookie(headers: Headers | undefined): Promise<void> {
  const raw = headers?.get("set-cookie");
  if (!raw) return;
  const jar = await cookies();
  parseSetCookieHeader(raw).forEach((value, name) => {
    jar.set(name, value.value, toCookieOptions(value));
  });
}
