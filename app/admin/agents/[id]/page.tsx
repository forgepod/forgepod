import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { database } from "@/db";
import { HOOKS, isFilterHook, listBindings, type StoredBinding } from "@/agents/hooks";
import { latestRun, loadAgent } from "@/agents/store";
import { formatParams, formatReturn, type Schema } from "@/plugins/signature";
import { pendingApprovals } from "@/plugins/approvals";
import { loadPlugins } from "@/plugins/store";
import { guard } from "@/auth/actor";
import { Masthead } from "../../../masthead";
import { PageHeader } from "../../../page-header";
import { bindHookAction, deleteAgentAction, saveAgentAction, unbindHookAction } from "../actions";
import { ConfirmButton } from "./confirm-button";
import { RunPanel } from "./run-panel";

export const dynamic = "force-dynamic";

export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; hookError?: string }>;
}) {
  const verdict = await guard(await headers(), "admin.read");
  if (!verdict.ok) redirect("/login");

  const { id } = await params;
  const { saved, hookError } = await searchParams;

  const db = await database();
  const agent = await loadAgent(db, id);
  if (!agent) notFound();

  const plugins = await loadPlugins(db);
  const run = await latestRun(db, id);
  const bindings = await listBindings(db, id);
  // Only for the run on screen: a card belongs where the call would have been, and
  // asking every approval plugin costs a plugin launch.
  const held = run ? await pendingApprovals(db, run.id) : [];
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

      <Hooks
        agentId={agent.id}
        bindings={bindings}
        handlers={plugins.flatMap((p) => p.tools.map((t) => `${p.name}::${t.name}`))}
        failure={hookError}
      />

      <RunPanel
        agentId={agent.id}
        stored={run}
        held={held}
        hasTools={agent.tools.length > 0}
      />

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

/**
 * Hooks are not part of the agent's version, so this is its own form rather than a
 * section of the one above: binding a guardrail must not publish a new version, and
 * publishing must not drop a guardrail.
 */
function Hooks({
  agentId,
  bindings,
  handlers,
  failure,
}: {
  agentId: string;
  bindings: StoredBinding[];
  handlers: string[];
  failure?: string;
}) {
  return (
    <section className="field-group">
      <span className="label">Hooks</span>
      <p className="note">
        A hook calls a plugin tool at one point in a run. An action is told what happened;
        a filter decides whether the tool call runs at all, which is why it needs a plugin
        you have marked trusted on the <Link href="/admin/plugins">plugins page</Link>.
      </p>

      {failure ? (
        <div className="failure">
          <p>{failure}</p>
        </div>
      ) : null}

      {bindings.length === 0 ? (
        <p className="note">Nothing bound. Runs go straight through.</p>
      ) : (
        bindings.map((binding) => (
          <form action={unbindHookAction} className="row" key={binding.id}>
            <input type="hidden" name="id" value={agentId} />
            <input type="hidden" name="binding" value={binding.id} />
            <span className="mono">
              {binding.hook} → {binding.pluginName}.{binding.toolName}
            </span>
            <span className="hint">
              {isFilterHook(binding.hook) ? "filter" : "action"}, priority {binding.priority}
              {binding.agentId === null ? ", every agent" : ""}
            </span>
            <button type="submit" className="action-quiet">
              Unbind
            </button>
          </form>
        ))
      )}

      {handlers.length === 0 ? null : (
        <form action={bindHookAction} className="row">
          <input type="hidden" name="id" value={agentId} />
          <select name="hook" className="field" defaultValue="run.after">
            {HOOKS.map((hook) => (
              <option key={hook} value={hook}>
                {hook} ({isFilterHook(hook) ? "filter" : "action"})
              </option>
            ))}
          </select>
          <select name="handler" className="field">
            {handlers.map((handler) => (
              <option key={handler} value={handler}>
                {handler.replace("::", ".")}
              </option>
            ))}
          </select>
          <input
            name="priority"
            type="number"
            defaultValue={10}
            className="field"
            aria-label="Priority, lowest first"
          />
          <button type="submit" className="action-quiet">
            Bind
          </button>
        </form>
      )}
    </section>
  );
}
