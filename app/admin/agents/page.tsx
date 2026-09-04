import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { database } from "@/db";
import { listAgents } from "@/agents/store";
import { loadPlugins } from "@/plugins/store";
import { guard } from "@/auth/actor";
import { Masthead } from "../../masthead";
import { PageHeader } from "../../page-header";
import { createAgentAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ hookError?: string }>;
}) {
  const verdict = await guard(await headers(), "admin.read");
  if (!verdict.ok) redirect("/login");

  const { hookError } = await searchParams;

  const db = await database();
  const agents = await listAgents(db);
  const plugins = await loadPlugins(db);
  const tools = plugins.reduce((n, p) => n + p.tools.length, 0);

  return (
    <main className="sheet">
      <Masthead here="agents" />

      <PageHeader
        title="Agents"
        status={agents.length > 0 ? plural(agents.length, "agent") : undefined}
        note={
          agents.length === 0
            ? "An agent is a prompt, a model, and the tools it may call. Name one to start."
            : undefined
        }
      />

      {tools === 0 ? (
        <p className="note">
          No tools available yet. <Link href="/admin/plugins">Scan your plugins</Link> first,
          and an agent will have something to reach for.
        </p>
      ) : null}

      {hookError ? (
        <div className="failure">
          <p>{hookError}</p>
        </div>
      ) : null}

      <form action={createAgentAction} className="row">
        <input name="name" placeholder="Name the agent" required className="field" />
        <button type="submit" className="action">
          Create
        </button>
      </form>

      {agents.map((agent) => (
        <section className="plugin" key={agent.id}>
          <div className="plugin-head">
            <h2>
              <Link href={`/admin/agents/${agent.id}`}>{agent.name}</Link>{" "}
              <span className="version">v{agent.version}</span>
            </h2>
            <span className="count">{plural(agent.toolCount, "tool")} bound</span>
          </div>
          <dl className="meta">
            <dt>model</dt>
            <dd>{agent.model}</dd>
          </dl>
        </section>
      ))}
    </main>
  );
}
