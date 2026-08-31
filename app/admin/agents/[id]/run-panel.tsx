"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { appendText, readEvents, type LiveStep } from "@/agents/stream";
import type { RunRecord } from "@/agents/store";
import type { Pending } from "@/plugins/approvals";
import { resolveApprovalAction } from "../actions";

export function RunPanel({
  agentId,
  stored,
  held,
  hasTools,
}: {
  agentId: string;
  stored: RunRecord | null;
  held: Pending[];
  hasTools: boolean;
}) {
  const router = useRouter();
  const [input, setInput] = useState(stored?.input ?? "");
  const [live, setLive] = useState<LiveStep[]>([]);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [finishedRunId, setFinishedRunId] = useState<string | null>(null);

  // The preview gives way to the stored run the moment the refreshed page carries it,
  // so the same transcript is never on screen twice.
  const showStored = !running && stored && (finishedRunId === null || stored.id === finishedRunId);

  async function run(submit: React.FormEvent) {
    submit.preventDefault();
    setLive([]);
    setFailure(null);
    setFinishedRunId(null);
    setRunning(true);

    try {
      const response = await fetch(`/api/agents/${agentId}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
      });
      if (!response.body) throw new Error("The server sent no stream.");

      for await (const message of readEvents(response.body)) {
        if (message.kind === "done") {
          setFailure(message.error);
          setFinishedRunId(message.runId);
          router.refresh();
        } else if (message.kind === "delta") {
          setLive((current) => appendText(current, message.text));
        } else if (
          message.kind === "tool_call" ||
          message.kind === "tool_result" ||
          message.kind === "note"
        ) {
          setLive((current) => [...current, message]);
        }
      }
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const steps: LiveStep[] = showStored
    ? (stored.steps.filter((s) => s.kind !== "text" || s.text.trim() !== "") as LiveStep[])
    : live;

  // A card belongs where the call was refused, not in a list of its own, so the run
  // around it stays readable. Matched by tool in the order the calls were made, since
  // that is the order the plugin recorded them in.
  const waiting = showStored ? [...held] : [];
  const cards = steps.map((step) => {
    if (step.kind !== "tool_result" || !step.isError) return null;
    const at = waiting.findIndex((p) => p.tool === step.tool);
    return at === -1 ? null : waiting.splice(at, 1)[0];
  });

  return (
    <section className="plugin">
      <div className="plugin-head">
        <h2>Try it</h2>
        {showStored && !stored.error ? (
          <span className="count">
            {stored.inputTokens} in, {stored.outputTokens} out
          </span>
        ) : running ? (
          <span className="state state-up">running</span>
        ) : null}
      </div>

      <form onSubmit={run}>
        <textarea
          rows={3}
          className="field"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            hasTools
              ? "Ask something that should make the agent reach for a tool."
              : "This agent has no tools bound yet. It can still answer from the prompt alone."
          }
        />
        <div className="row">
          <button type="submit" className="action" disabled={running}>
            {running ? "Running" : "Run"}
          </button>
          <span className="hint">Runs the saved version.</span>
        </div>
      </form>

      {failure ?? (showStored ? stored.error : null) ? (
        <div className="failure">
          <p>{failure ?? stored?.error}</p>
        </div>
      ) : null}

      {steps.length > 0 ? (
        <div className="tools">
          {steps.map((step, index) =>
            step.kind === "text" ? (
              <p className="say" key={index}>
                {step.text}
                {running && index === steps.length - 1 ? <span className="cursor" /> : null}
              </p>
            ) : step.kind === "note" ? (
              // Written by core, not by the model, so it must not read like an answer.
              <p className="hint" key={index}>
                {step.text}
              </p>
            ) : step.kind === "tool_call" ? (
              <pre className="sig" key={index}>
                <code>
                  {step.tool}({JSON.stringify(step.input)})
                </code>
              </pre>
            ) : (
              <Fragment key={index}>
                <pre className={`sig ${step.isError ? "sig-error" : ""}`}>
                  <code>
                    {"→ "}
                    <span className={step.isError ? "untyped" : "ret"}>
                      {JSON.stringify(step.output)}
                    </span>
                  </code>
                </pre>
                {cards[index] ? <Card held={cards[index]} agentId={agentId} /> : null}
              </Fragment>
            ),
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Three answers, no modal, and refusing is one of them. The action still reads as a tool
 * call and its arguments, which is what #33 is for; the sentence lands with that work
 * rather than being guessed at here.
 */
function Card({ held, agentId }: { held: Pending; agentId: string }) {
  return (
    <div className="failure asking">
      <p>
        Agent wants to call {held.tool}({JSON.stringify(held.input)})
      </p>
      <form action={resolveApprovalAction} className="row">
        <input type="hidden" name="id" value={agentId} />
        <input type="hidden" name="plugin" value={held.plugin} />
        <input type="hidden" name="approval" value={held.id} />
        <button type="submit" name="decision" value="refuse" className="action-quiet">
          Refuse
        </button>
        <button type="submit" name="decision" value="allow_once" className="action">
          Allow once
        </button>
        <button type="submit" name="decision" value="always" className="action-quiet">
          Always allow
        </button>
        <span className="hint">An answer applies to the next run of this agent.</span>
      </form>
    </div>
  );
}
