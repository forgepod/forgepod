import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Kysely } from "kysely";
import type { Schema } from "../db/schema";
import { connect, PluginManifest } from "../plugins/mcp";
import type { Exchange, Provider, ToolOutcome } from "./provider";

export type RunnableTool = {
  apiName: string;
  pluginName: string;
  toolName: string;
  description: string | null;
  inputSchema: unknown;
  manifest: PluginManifest;
};

export type RunStep =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; tool: string; input: unknown }
  | { kind: "tool_result"; tool: string; output: unknown; isError: boolean };

export type RunOutcome = {
  runId: string;
  answer: string;
  steps: RunStep[];
  inputTokens: number;
  outputTokens: number;
  error: string | null;
};

/**
 * Tool names are constrained by the providers, not by us: the narrower limit across the
 * ones supported is 64 characters from a restricted alphabet, and plugin names are free
 * text. Prefixing keeps two plugins from colliding on a common tool name.
 */
const apiNameFor = (plugin: string, tool: string) =>
  `${plugin}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

export async function runnableTools(
  db: Kysely<Schema>,
  agentVersionId: string,
): Promise<RunnableTool[]> {
  const rows = await db
    .selectFrom("agent_tools")
    .innerJoin("plugin_tools", (join) =>
      join
        .onRef("plugin_tools.plugin_name", "=", "agent_tools.plugin_name")
        .onRef("plugin_tools.name", "=", "agent_tools.tool_name"),
    )
    .innerJoin("plugins", "plugins.name", "agent_tools.plugin_name")
    .select([
      "agent_tools.plugin_name",
      "agent_tools.tool_name",
      "plugin_tools.description",
      "plugin_tools.input_schema",
      "plugins.manifest",
    ])
    .where("agent_tools.agent_version_id", "=", agentVersionId)
    .orderBy("agent_tools.plugin_name")
    .orderBy("agent_tools.tool_name")
    .execute();

  return rows.map((row) => ({
    apiName: apiNameFor(row.plugin_name, row.tool_name),
    pluginName: row.plugin_name,
    toolName: row.tool_name,
    description: row.description,
    inputSchema: JSON.parse(row.input_schema),
    manifest: PluginManifest.parse(JSON.parse(row.manifest)),
  }));
}

/**
 * The loop is written out rather than delegated to a helper because the tools arrive at
 * runtime from MCP as raw JSON Schema, and because every turn has to be recorded: a run
 * that cannot be read back afterwards is not auditable.
 */
export async function runAgent(args: {
  db: Kysely<Schema>;
  provider: Provider;
  version: { id: string; model: string; systemPrompt: string };
  tools: RunnableTool[];
  input: string;
  maxTurns?: number;
  now?: () => string;
}): Promise<RunOutcome> {
  const { db, provider, version, tools, input } = args;
  const now = args.now ?? (() => new Date().toISOString());
  const maxTurns = args.maxTurns ?? 8;

  const runId = crypto.randomUUID();
  await db
    .insertInto("runs")
    .values({
      id: runId,
      agent_version_id: version.id,
      status: "running",
      input,
      started_at: now(),
      ended_at: null,
      error: null,
    })
    .execute();

  const steps: RunStep[] = [];
  const history: Exchange[] = [{ role: "user", text: input }];
  const byApiName = new Map(tools.map((t) => [t.apiName, t]));
  // Opened once per run and reused across turns, so a five-turn conversation does not
  // start the same container five times.
  const open = new Map<string, Client>();

  let seq = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let answer = "";
  let error: string | null = null;

  const record = async (step: RunStep) => {
    steps.push(step);
    await db
      .insertInto("run_steps")
      .values({ run_id: runId, seq: seq++, kind: step.kind, payload: JSON.stringify(step) })
      .execute();
  };

  const clientFor = async (tool: RunnableTool): Promise<Client> => {
    const existing = open.get(tool.pluginName);
    if (existing) return existing;
    const opened = await connect(tool.manifest);
    open.set(tool.pluginName, opened);
    return opened;
  };

  try {
    for (let turn = 0; ; turn++) {
      if (turn >= maxTurns) throw new Error(`stopped after ${maxTurns} turns without an answer`);

      const turnResult = await provider.send({
        model: version.model,
        system: version.systemPrompt,
        history,
        tools: tools.map((tool) => ({
          name: tool.apiName,
          description: tool.description ?? `${tool.toolName} from ${tool.pluginName}`,
          inputSchema: tool.inputSchema,
        })),
      });

      await db
        .insertInto("run_usage")
        .values({
          run_id: runId,
          seq: turn,
          provider: provider.name,
          model: version.model,
          input_tokens: turnResult.usage.inputTokens,
          output_tokens: turnResult.usage.outputTokens,
        })
        .execute();
      inputTokens += turnResult.usage.inputTokens;
      outputTokens += turnResult.usage.outputTokens;

      for (const text of turnResult.text) await record({ kind: "text", text });

      if (turnResult.done) {
        answer = turnResult.text.join("\n").trim();
        break;
      }

      // Every tool result goes back in one exchange, failures included. Dropping a
      // failed one leaves the model waiting for an answer that never arrives.
      const results: ToolOutcome[] = [];
      for (const call of turnResult.toolCalls) {
        await record({ kind: "tool_call", tool: call.name, input: call.input });
        const tool = byApiName.get(call.name);

        if (!tool) {
          await record({ kind: "tool_result", tool: call.name, output: "unknown tool", isError: true });
          results.push({ id: call.id, content: "unknown tool", isError: true });
          continue;
        }

        try {
          const result = await (
            await clientFor(tool)
          ).callTool({ name: tool.toolName, arguments: call.input as Record<string, unknown> });

          const output = result.structuredContent ?? result.content;
          const failed = result.isError === true;
          await record({ kind: "tool_result", tool: call.name, output, isError: failed });
          results.push({ id: call.id, content: JSON.stringify(output), isError: failed });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await record({ kind: "tool_result", tool: call.name, output: message, isError: true });
          results.push({ id: call.id, content: message, isError: true });
        }
      }

      history.push({ role: "assistant", raw: turnResult.raw });
      history.push({ role: "tool_results", results });
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    await Promise.all([...open.values()].map((c) => c.close().catch(() => undefined)));
  }

  await db
    .updateTable("runs")
    .set({ status: error ? "failed" : "completed", ended_at: now(), error })
    .where("id", "=", runId)
    .execute();

  return { runId, answer, steps, inputTokens, outputTokens, error };
}
