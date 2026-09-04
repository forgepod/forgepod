import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { actorFrom } from "@/auth/actor";
import { applySetCookie } from "./login/actions";

/**
 * Better Auth's own `POST /api/auth/sign-out` demands `Content-Type: application/json`
 * (confirmed against the installed 1.7.2: a plain form submission's
 * `application/x-www-form-urlencoded` gets a 415). An HTML `<form>` has no way to send
 * that content type, so posting straight to the route would 415 and leave the session
 * standing. Calling the instance directly sidesteps the HTTP layer's media-type check
 * the same way `app/login/actions.ts` already signs in without going through it.
 */
async function signOutAction(): Promise<void> {
  "use server";
  const instance = await auth();
  const { headers: responseHeaders } = await instance.api.signOut({
    headers: await headers(),
    returnHeaders: true,
  });
  await applySetCookie(responseHeaders);
  redirect("/login");
}

/**
 * A page that renders this has already gone through its own `guard`, so the actor here
 * is almost always set. It is looked up again anyway rather than passed in, because a
 * masthead that could be dropped onto a page without it also needing to thread an actor
 * through is worth the one extra lookup. A missing actor renders the wordmark and nav
 * with neither the people link nor sign out, rather than throwing.
 */
export async function Masthead({ here }: { here: "plugins" | "agents" | "templates" | "people" }) {
  const actor = await actorFrom(await headers());

  return (
    <header className="masthead">
      <span className="wordmark">ForgePod</span>
      <nav className="crumb">
        <Link href="/admin/agents" aria-current={here === "agents" ? "page" : undefined}>
          agents
        </Link>
        <Link href="/admin/plugins" aria-current={here === "plugins" ? "page" : undefined}>
          plugins
        </Link>
        <Link href="/admin/templates" aria-current={here === "templates" ? "page" : undefined}>
          templates
        </Link>
        {actor?.role === "owner" ? (
          <Link href="/admin/people" aria-current={here === "people" ? "page" : undefined}>
            people
          </Link>
        ) : null}
      </nav>
      {actor ? (
        <form action={signOutAction}>
          <button type="submit" className="action-quiet">
            Sign out
          </button>
        </form>
      ) : null}
    </header>
  );
}
