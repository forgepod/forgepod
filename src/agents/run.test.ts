import { expect, test } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../db/bun-sqlite";
import { migrate } from "../db/migrate";
import type { Schema } from "../db/schema";
import { defaultRuntime } from "../plugins/mcp";
import { inspect, installedPlugins } from "../plugins/registry";
import { saveScan } from "../plugins/store";
import { createAgent, publishVersion } from "./store";
import { anthropicProvider } from "./providers";
import { runAgent, runnableTools } from "./run";

const image = "forgepod/beam-mcp:0.1.0";

async function imageIsBuilt(): Promise<boolean> {
  try {
    const probe = Bun.spawn([defaultRuntime(), "image", "inspect", image], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await probe.exited) === 0;
  } catch {
    return false;
  }
}

const built = await imageIsBuilt();
if (!built) console.warn("skipping the agent run test: run `bun run plugin:image` first");

/** Replaces the provider's HTTP, so the loop is exercised while the tool call is real. */
function stubbedProvider(bodies: unknown[]) {
  const sent: unknown[] = [];
  let turn = 0;

  const provider = anthropicProvider({
    apiKey: "not-a-real-key",
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      const body = bodies[Math.min(turn++, bodies.length - 1)];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  return { provider, sent };
}

const message = (content: unknown, stopReason: string, tokens: [number, number]) => ({
  id: `msg_${stopReason}`,
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: tokens[0], output_tokens: tokens[1] },
});

test.skipIf(!built)(
  "an agent calls a real plugin tool and every turn is recorded",
  async () => {
    const db = new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });
    await migrate(db);

    // The tool schema the agent is offered comes from the plugin itself, not a fixture.
    const scan = await Promise.all((await installedPlugins()).map(inspect));
    await saveScan(db, scan, new Date().toISOString());

    const agentId = await createAgent(db, { name: "Beam checker" });
    const versionId = await publishVersion(db, agentId, {
      model: "claude-opus-5",
      systemPrompt: "Answer with the left support reaction.",
      tools: [{ pluginName: "beam-mcp", toolName: "beam_reactions" }],
    });

    const tools = await runnableTools(db, versionId);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.apiName).toBe("beam-mcp__beam_reactions");
    expect(tools[0]?.inputSchema).toMatchObject({ required: expect.arrayContaining(["span_m"]) });

    const { provider, sent } = stubbedProvider([
      message(
        [
          { type: "text", text: "Computing the reactions." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "beam-mcp__beam_reactions",
            input: { span_m: 6, load_kn: 10, load_from_left_m: 2 },
          },
        ],
        "tool_use",
        [120, 40],
      ),
      message([{ type: "text", text: "The left support carries 6.67 kN." }], "end_turn", [260, 18]),
    ]);

    const outcome = await runAgent({
      db,
      provider,
      version: { id: versionId, model: "claude-opus-5", systemPrompt: "Answer briefly." },
      tools,
      input: "6 m span, 10 kN at 2 m. What does the left support carry?",
    });

    expect(outcome.error).toBeNull();
    expect(outcome.answer).toBe("The left support carries 6.67 kN.");
    expect(outcome.inputTokens).toBe(380);
    expect(outcome.outputTokens).toBe(58);

    const toolResult = outcome.steps.find((s) => s.kind === "tool_result");
    expect(toolResult).toMatchObject({ tool: "beam-mcp__beam_reactions", isError: false });
    expect((toolResult as { output: Record<string, number> }).output.reaction_left_kn).toBeCloseTo(
      6.666667,
      5,
    );

    // The second request must carry the tool result back, or the model answered blind.
    expect(sent).toHaveLength(2);
    const secondBody = JSON.stringify(sent[1]);
    expect(secondBody).toContain("tool_result");
    expect(secondBody).toContain("6.666667");

    const run = await db.selectFrom("runs").selectAll().executeTakeFirstOrThrow();
    expect(run.status).toBe("completed");
    expect(run.ended_at).not.toBeNull();

    const steps = await db.selectFrom("run_steps").selectAll().orderBy("seq").execute();
    expect(steps.map((s) => s.kind)).toEqual(["text", "tool_call", "tool_result", "text"]);

    const usage = await db.selectFrom("run_usage").selectAll().execute();
    expect(usage).toHaveLength(2);

    await db.destroy();
  },
  120_000,
);

test.skipIf(!built)("a tool that throws is reported back rather than ending the run", async () => {
  const db = new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });
  await migrate(db);
  const scan = await Promise.all((await installedPlugins()).map(inspect));
  await saveScan(db, scan, new Date().toISOString());

  const agentId = await createAgent(db, { name: "Beam checker" });
  const versionId = await publishVersion(db, agentId, {
    model: "claude-opus-5",
    systemPrompt: "",
    tools: [{ pluginName: "beam-mcp", toolName: "beam_reactions" }],
  });

  const { provider } = stubbedProvider([
    message(
      [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "beam-mcp__beam_reactions",
          input: { span_m: -1, load_kn: 10, load_from_left_m: 2 },
        },
      ],
      "tool_use",
      [10, 10],
    ),
    message([{ type: "text", text: "That span is not valid." }], "end_turn", [10, 10]),
  ]);

  const outcome = await runAgent({
    db,
    provider,
    version: { id: versionId, model: "claude-opus-5", systemPrompt: "" },
    tools: await runnableTools(db, versionId),
    input: "negative span",
  });

  expect(outcome.error).toBeNull();
  expect(outcome.answer).toBe("That span is not valid.");
  expect(outcome.steps.find((s) => s.kind === "tool_result")).toMatchObject({ isError: true });

  await db.destroy();
}, 120_000);
