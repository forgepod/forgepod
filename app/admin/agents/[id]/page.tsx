import { notFound } from "next/navigation";
import { database } from "@/db";
import { latestRun, loadAgent, type RunRecord } from "@/agents/store";
import type { RunStep } from "@/agents/run";
import { formatParams, formatReturn, type Schema } from "@/plugins/signature";
import { loadPlugins } from "@/plugins/store";
import { Masthead } from "../../../masthead";
import { saveAgentAction } from "../actions";
import { RunPanel } from "./run-panel";

export const dynamic = "force-dynamic";

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await database();
  const agent = await loadAgent(db, id);
  if (!agent) notFound();

  const plugins = await loadPlugins(db);
  const run = await latestRun(db, id);
  const bound = new Set(agent.tools.map((t) => `${t.pluginName}::${t.toolName}`));

  return (
    <main className="sheet">
      <Masthead here="agents" />

      <div className="summary">
        <h1>{agent.name}</h1>
        <p className="tally">
          version {agent.version}, {agent.tools.length} bound
        </p>
      </div>

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
            placeholder="Tell the agent what it is for and when to reach for a tool."
          />
        </div>

        <div className="field-group">
          <span className="label">Tools</span>
          {plugins.length === 0 ? (
            <p className="note">
              No plugins scanned yet. Scan on the plugins page and the tools appear here.
            </p>
          ) : (
            plugins.map((plugin) => (
              <fieldset className="picker" key={plugin.name}>
                <legend>{plugin.name}</legend>
                {plugin.tools.map((tool) => {
                  const value = `${plugin.name}::${tool.name}`;
                  return (
                    <label className="pick" key={value}>
                      <input type="checkbox" name="tool" value={value} defaultChecked={bound.has(value)} />
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
        </div>
      </form>

      <RunPanel agentId={agent.id} initialInput={run?.input ?? ""} />

      {run ? <Transcript run={run} /> : null}
    </main>
  );
}

function Transcript({ run }: { run: RunRecord }) {
  return (
    <section className="plugin">
      <div className="plugin-head">
        <h2>Last run</h2>
        <span className={`state ${run.error ? "state-down" : "state-up"}`}>
          {run.error ? "failed" : `${run.inputTokens} in, ${run.outputTokens} out`}
        </span>
      </div>

      {run.error ? (
        <div className="failure">
          <p>{run.error}</p>
        </div>
      ) : null}

      <div className="tools">
        {run.steps.map((step, index) => (
          <StepView key={index} step={step} />
        ))}
      </div>
    </section>
  );
}

function StepView({ step }: { step: RunStep }) {
  if (step.kind === "text") return <p className="say">{step.text}</p>;

  if (step.kind === "tool_call") {
    return (
      <pre className="sig">
        <code>
          {step.tool}({JSON.stringify(step.input)})
        </code>
      </pre>
    );
  }

  return (
    <pre className={`sig ${step.isError ? "sig-error" : ""}`}>
      <code>
        {"→ "}
        <span className={step.isError ? "untyped" : "ret"}>{JSON.stringify(step.output)}</span>
      </code>
    </pre>
  );
}
