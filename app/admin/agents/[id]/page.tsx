import Link from "next/link";
import { notFound } from "next/navigation";
import { database } from "@/db";
import { latestRun, loadAgent } from "@/agents/store";
import { formatParams, formatReturn, type Schema } from "@/plugins/signature";
import { loadPlugins } from "@/plugins/store";
import { Masthead } from "../../../masthead";
import { PageHeader } from "../../../page-header";
import { deleteAgentAction, saveAgentAction } from "../actions";
import { ConfirmButton } from "./confirm-button";
import { RunPanel } from "./run-panel";

export const dynamic = "force-dynamic";

export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  const { saved } = await searchParams;

  const db = await database();
  const agent = await loadAgent(db, id);
  if (!agent) notFound();

  const plugins = await loadPlugins(db);
  const run = await latestRun(db, id);
  const bound = new Set(agent.tools.map((t) => `${t.pluginName}::${t.toolName}`));
  const toolCount = plugins.reduce((n, p) => n + p.tools.length, 0);
  // A binding survives a rescan, so it can outlive the tool it names. Saying so here is
  // the difference between an agent that lost a tool and an agent that lost one quietly.
  const unavailable = agent.tools.filter((t) => !t.available);

  return (
    <main className="sheet">
      <Masthead here="agents" />

      <PageHeader
        title={agent.name}
        status={`version ${agent.version}, ${agent.tools.length} of ${toolCount} tools bound${
          unavailable.length > 0 ? `, ${unavailable.length} unavailable` : ""
        }`}
        note={saved ? `Version ${saved} published.` : undefined}
      />

      {unavailable.length > 0 ? (
        <div className="failure">
          <p>
            No scanned plugin publishes {unavailable.length === 1 ? "this tool" : "these tools"} any
            more, so runs go ahead without {unavailable.length === 1 ? "it" : "them"}:{" "}
            {unavailable.map((t) => `${t.pluginName}.${t.toolName}`).join(", ")}
          </p>
          <p>
            Scan plugins if one is installed but unread. Publishing a new version below drops the
            bindings that are left.
          </p>
        </div>
      ) : null}

      <form action={saveAgentAction}>
        <input type="hidden" name="id" value={agent.id} />

        <div className="field-group">
          <label htmlFor="model">Model</label>
          <input id="model" name="model" defaultValue={agent.model} className="field" />
        </div>

        <div className="field-group">
          <label htmlFor="systemPrompt">System prompt</label>
          <textarea
            id="systemPrompt"
            name="systemPrompt"
            defaultValue={agent.systemPrompt}
            rows={8}
            className="field"
            placeholder="Tell the agent what it is for, and when to reach for a tool."
          />
        </div>

        <div className="field-group">
          <span className="label">Tools</span>
          {plugins.length === 0 ? (
            <p className="note">
              No plugins scanned yet. <Link href="/admin/plugins">Scan them</Link> and every
              tool they publish appears here.
            </p>
          ) : (
            plugins.map((plugin) => (
              <fieldset className="picker" key={plugin.name}>
                <legend>{plugin.name}</legend>
                {plugin.tools.map((tool) => {
                  const value = `${plugin.name}::${tool.name}`;
                  return (
                    <label className="pick" key={value}>
                      <input
                        type="checkbox"
                        name="tool"
                        value={value}
                        defaultChecked={bound.has(value)}
                      />
                      <span className="pick-body">
                        <span className="pick-name">{tool.name}</span>
                        <span className="pick-sig">
                          ({formatParams(tool.inputSchema as Schema)}) →{" "}
                          {formatReturn(tool.outputSchema as Schema | undefined)}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            ))
          )}
        </div>

        <div className="row">
          <button type="submit" className="action">
            Save
          </button>
          <span className="hint">Saving publishes a new version.</span>
        </div>
      </form>

      <RunPanel agentId={agent.id} stored={run} hasTools={agent.tools.length > 0} />

      <form action={deleteAgentAction} className="danger-zone">
        <input type="hidden" name="id" value={agent.id} />
        <ConfirmButton question={`Delete ${agent.name} and every run it recorded?`}>
          Delete agent
        </ConfirmButton>
        <span className="hint">Its versions and run history go with it.</span>
      </form>
    </main>
  );
}
