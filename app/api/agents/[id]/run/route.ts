import { database } from "@/db";
import { providerFromEnv } from "@/agents/providers";
import { runAgent, runnableTools, type RunEvent } from "@/agents/run";
import { loadAgent } from "@/agents/store";

export const dynamic = "force-dynamic";

/**
 * Runs the published version and streams what happens. The run is written to the
 * database as it goes, so closing the tab loses the live view and nothing else.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { input } = (await request.json()) as { input?: string };

  const db = await database();
  const agent = await loadAgent(db, id);
  if (!agent) return new Response("No such agent.", { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: RunEvent | { kind: "done"; runId: string | null; error: string | null }) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

      try {
        const outcome = await runAgent({
          db,
          provider: providerFromEnv(),
          version: { id: agent.versionId, model: agent.model, systemPrompt: agent.systemPrompt },
          tools: await runnableTools(db, agent.versionId),
          input: input ?? "",
          onEvent: send,
        });
        send({ kind: "done", runId: outcome.runId, error: outcome.error });
      } catch (e) {
        // A missing key or an unreachable gateway lands here, and the operator needs to
        // read it rather than find a dead stream.
        send({ kind: "done", runId: null, error: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
    },
  });
}
