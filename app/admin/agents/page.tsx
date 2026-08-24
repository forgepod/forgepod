import Link from "next/link";
import { database } from "@/db";
import { listAgents } from "@/agents/store";
import { Masthead } from "../../masthead";
import { createAgentAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents" };

export default async function AgentsPage() {
  const agents = await listAgents(await database());

  return (
    <main className="sheet">
      <Masthead here="agents" />

      <div className="summary">
        <h1>Agents</h1>
      </div>

      <p className="note">
        {agents.length === 0
          ? "An agent is a prompt, a model and the tools it may call. Name one to start."
          : "Saving an agent publishes a new version. Runs record the version they used, so history stays true."}
      </p>

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
            <span className="state state-up">
              {agent.toolCount} {agent.toolCount === 1 ? "tool" : "tools"}
            </span>
          </div>
          <dl className="meta">
            <dt>model</dt>
            <dd>{agent.model}</dd>
            <dt>slug</dt>
            <dd>{agent.slug}</dd>
          </dl>
        </section>
      ))}
    </main>
  );
}
