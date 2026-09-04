import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { database } from "@/db";
import { auth } from "@/auth";
import { hasAnyUser } from "@/auth/bootstrap";
import { actorFrom } from "@/auth/actor";
import { PageHeader } from "../page-header";
import { claimAction, signInAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;

  // Awaited explicitly before hasAnyUser reads the `user` table: `auth()` is what runs
  // Better Auth's own migrations and creates that table on a fresh install. actorFrom
  // also calls `auth()` internally, so calling it here first is not what makes this
  // work, it is what keeps the order from being an accident of which line happens to
  // run first. Swap this for the line below it and a fresh install 500s on this page.
  await auth();

  if (await actorFrom(await headers())) redirect("/admin/agents");

  const claimed = await hasAnyUser(await database());

  return (
    <main className="sheet">
      <PageHeader
        title={claimed ? "Sign in" : "Claim this install"}
        note={
          claimed
            ? "This install has an owner already."
            : "Nobody owns this install yet. The first account made here owns it, and sign-up closes behind you."
        }
      />
      {error ? (
        <div className="failure">
          <p>{error}</p>
        </div>
      ) : null}
      <form action={claimed ? signInAction : claimAction}>
        {!claimed && (
          <div className="field-group">
            <label htmlFor="name">Name</label>
            <input id="name" name="name" placeholder="Name" required className="field" />
          </div>
        )}
        <div className="field-group">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" placeholder="Email" required className="field" />
        </div>
        <div className="field-group">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            placeholder="Password"
            required
            minLength={12}
            className="field"
          />
        </div>
        <button type="submit" className="action">
          {claimed ? "Sign in" : "Claim it"}
        </button>
      </form>
    </main>
  );
}
