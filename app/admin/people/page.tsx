import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { database } from "@/db";
import { guard } from "@/auth/actor";
import type { Role } from "@/auth/policy";
import { Masthead } from "../../masthead";
import { PageHeader } from "../../page-header";
import { createPersonAction, revokeKeyAction, setRoleAction } from "./actions";
import { IssueKeyForm } from "./issue-key-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "People" };

const CREATABLE_ROLES: readonly Role[] = ["editor", "runner"];
const SETTABLE_ROLES: readonly Role[] = ["owner", "editor", "runner"];

type PersonRow = {
  id: string;
  name: string;
  email: string;
  role: string | null;
  banned: boolean | number | null;
};

type KeyRow = {
  id: string;
  name: string | null;
  referenceId: string;
  createdAt: string;
  lastRequest: string | null;
  enabled: boolean | number;
};

/**
 * Better Auth owns `user` and `apikey`; both are deliberately absent from `Schema`, the
 * same reason `src/auth/actor.ts` and `src/auth/bootstrap.ts` read `user` with
 * `as never`. Listing across every person's keys also has no admin endpoint to call:
 * Better Auth's own `/api-key/list` always scopes to the caller's own session id (see
 * `revokeKeyAction`'s comment in `./actions.ts` for the same limit on delete), so this
 * reads the table directly rather than inventing a wrapper around an endpoint that
 * cannot do what the page needs.
 */
async function loadPeople(): Promise<PersonRow[]> {
  const db = await database();
  return (await db
    .selectFrom("user" as never)
    .select(["id", "name", "email", "role", "banned"] as never)
    .orderBy("email" as never)
    .execute()) as unknown as PersonRow[];
}

async function loadKeys(): Promise<KeyRow[]> {
  const db = await database();
  return (await db
    .selectFrom("apikey" as never)
    .select(["id", "name", "referenceId", "createdAt", "lastRequest", "enabled"] as never)
    .orderBy("createdAt" as never, "desc" as never)
    .execute()) as unknown as KeyRow[];
}

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const verdict = await guard(await headers(), "user.manage");
  // A signed-in editor or runner landing here is being told they lack permission, not
  // asked to authenticate, so they go back to a page they can use rather than /login.
  // Someone with no session at all still gets sent to /login.
  if (!verdict.ok) redirect(verdict.status === 401 ? "/login" : "/admin/agents");

  const { error } = await searchParams;
  const people = await loadPeople();
  const keys = await loadKeys();
  const byId = new Map(people.map((p) => [p.id, p]));

  return (
    <main className="sheet">
      <Masthead here="people" />

      <PageHeader
        title="People"
        status={`${people.length} ${people.length === 1 ? "person" : "people"}, ${keys.length} ${keys.length === 1 ? "key" : "keys"}`}
        note="Add people, set what they can do, and issue the API keys that let an outside system run an agent as one of them."
      />

      {error ? (
        <div className="failure">
          <p>{error}</p>
        </div>
      ) : null}

      <section className="field-group">
        <span className="label">Add a person</span>
        <form action={createPersonAction} className="row">
          <input name="name" placeholder="Name" required className="field" />
          <input name="email" type="email" placeholder="Email" required className="field" />
          <input
            name="password"
            type="password"
            placeholder="Password"
            required
            minLength={12}
            className="field"
          />
          <select name="role" defaultValue="runner" className="field">
            {CREATABLE_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
          <button type="submit" className="action">
            Add person
          </button>
        </form>
        <p className="hint">
          A second owner is not made here. Set a person&apos;s role to owner below once
          that is actually wanted.
        </p>
      </section>

      <section className="field-group">
        <span className="label">People</span>
        {people.map((person) => (
          <div className="row" key={person.id}>
            <span>
              {person.name} <span className="hint">{person.email}</span>
              {person.banned ? <span className="hint"> banned</span> : null}
              {person.id === verdict.actor.userId ? <span className="hint"> (you)</span> : null}
            </span>

            <form action={setRoleAction} className="row">
              <input type="hidden" name="userId" value={person.id} />
              <select name="role" defaultValue={person.role ?? "runner"} className="field">
                {SETTABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
              <button type="submit" className="action-quiet">
                Set role
              </button>
            </form>

            <IssueKeyForm userId={person.id} />
          </div>
        ))}
      </section>

      <section className="field-group">
        <span className="label">API keys</span>
        {keys.length === 0 ? (
          <p className="note">No keys issued yet.</p>
        ) : (
          keys.map((key) => (
            <form action={revokeKeyAction} className="row" key={key.id}>
              <input type="hidden" name="keyId" value={key.id} />
              <span className="mono">{key.name ?? "(unnamed)"}</span>
              <span className="hint">{byId.get(key.referenceId)?.email ?? key.referenceId}</span>
              <span className="hint">{key.lastRequest ? `last used ${key.lastRequest}` : "never used"}</span>
              <span className="hint">{key.enabled ? "enabled" : "disabled"}</span>
              <button type="submit" className="action-quiet">
                Revoke
              </button>
            </form>
          ))
        )}
      </section>
    </main>
  );
}
