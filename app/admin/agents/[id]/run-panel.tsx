"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { appendText, readEvents, type LiveStep } from "@/agents/stream";

export function RunPanel({ agentId, initialInput }: { agentId: string; initialInput: string }) {
  const router = useRouter();
  const [input, setInput] = useState(initialInput);
  const [live, setLive] = useState<LiveStep[]>([]);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    setLive([]);
    setFailure(null);
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
          setFailure(message.error ?? null);
          // The stored run is the record; the live view above was only a preview.
          router.refresh();
        } else if (message.kind === "delta") {
          setLive((current) => appendText(current, message.text));
        } else if (message.kind === "tool_call" || message.kind === "tool_result") {
          setLive((current) => [...current, message]);
        }
      }
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="plugin">
      <div className="plugin-head">
        <h2>Try it</h2>
        <span className="state state-up">runs the saved version</span>
      </div>

      <form onSubmit={run}>
        <textarea
          name="input"
          rows={3}
          className="field"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask something that should make the agent reach for a tool."
        />
        <div className="row">
          <button type="submit" className="action" disabled={running}>
            {running ? "Running" : "Run"}
          </button>
        </div>
      </form>

      {failure ? (
        <div className="failure">
          <p>{failure}</p>
        </div>
      ) : null}

      {live.length > 0 ? (
        <div className="tools">
          {live.map((step, index) =>
            step.kind === "text" ? (
              <p className="say" key={index}>
                {step.text}
                {running && index === live.length - 1 ? <span className="cursor" /> : null}
              </p>
            ) : step.kind === "tool_call" ? (
              <pre className="sig" key={index}>
                <code>
                  {step.tool}({JSON.stringify(step.input)})
                </code>
              </pre>
            ) : (
              <pre className={`sig ${step.isError ? "sig-error" : ""}`} key={index}>
                <code>
                  {"→ "}
                  <span className={step.isError ? "untyped" : "ret"}>
                    {JSON.stringify(step.output)}
                  </span>
                </code>
              </pre>
            ),
          )}
        </div>
      ) : null}
    </section>
  );
}
