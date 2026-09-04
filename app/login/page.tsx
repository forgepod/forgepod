import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { database } from "@/db";
import { hasAnyUser } from "@/auth/bootstrap";
import { actorFrom } from "@/auth/actor";
import { PageHeader } from "../page-header";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await actorFrom(await headers())) redirect("/admin/agents");

  const claimed = await hasAnyUser(await database());
  const path = claimed ? "/api/auth/sign-in/email" : "/api/auth/sign-up/email";

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
      <form method="post" action={path}>
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
        <input type="hidden" name="callbackURL" value="/admin/agents" />
        <button type="submit" className="action">
          {claimed ? "Sign in" : "Claim it"}
        </button>
      </form>
    </main>
  );
}
