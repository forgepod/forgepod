import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Kysely } from "kysely";
import type { Schema } from "../db/schema";
import { installId } from "../db/install";
import { connect, PluginManifest, resultValue } from "../plugins/mcp";
import { applyFilter, fireAction, loadBindings, type Invoke } from "./hooks";
import type { Exchange, Provider, ToolOutcome } from "./provider";
import type { BoundToolRef } from "./store";

export type RunnableTool = {
  apiName: string;
  pluginName: string;
  toolName: string;
  description: string | null;
  inputSchema: unknown;
  manifest: PluginManifest;
  /** Where the plugin is installed, which a plugin that keeps state is launched with. */
  sourceDir: string;
};

export type RunStep =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; tool: string; input: unknown }
  | { kind: "tool_result"; tool: string; output: unknown; isError: boolean }
  /** Something the run needs to admit about itself, written by core rather than the model. */
  | { kind: "note"; text: string };

/** A delta is live only. The recorded step for the same text follows it. */
export type RunEvent = RunStep | { kind: "delta"; text: string };

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
      "plugins.source_dir",
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
    sourceDir: row.source_dir,
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
  /**
   * `agentId` and `slug` name the agent this version belongs to, and are here because a
   * plugin has to know who is calling it. A stateful plugin keys on the slug: it is
   * authored once and identical on every install of a template, while the ids are
   * regenerated per install and per run.
   */
  version: { id: string; agentId: string; slug: string; model: string; systemPrompt: string };
  tools: RunnableTool[];
  /**
   * Bindings the agent declares that no installed plugin publishes any more. They cannot
   * be called, so the run records them instead: a run read back later has to show that it
   * answered with fewer tools than the agent was configured with.
   */
  unavailable?: BoundToolRef[];
  input: string;
  maxTurns?: number;
  now?: () => string;
  onEvent?: (event: RunEvent) => void;
}): Promise<RunOutcome> {
  const { db, provider, version, tools, input } = args;
  const now = args.now ?? (() => new Date().toISOString());
  const emit = args.onEvent ?? (() => undefined);
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
      actor_id: null,
    })
    .execute();

  const steps: RunStep[] = [];
  const history: Exchange[] = [{ role: "user", text: input }];
  const byApiName = new Map(tools.map((t) => [t.apiName, t]));
  // Opened once per run and reused across turns, so a five-turn conversation does not
  // start the same container five times.
  const open = new Map<string, Client>();
  const identity = {
    // Widest to narrowest. A plugin that keeps state keys on the install and the slug
    // together: the slug alone is the same on every install of one template, so two
    // installs sharing a plugin would read each other's rows as their own.
    FORGEPOD_INSTALL_ID: await installId(db),
    FORGEPOD_AGENT_ID: version.agentId,
    FORGEPOD_AGENT_SLUG: version.slug,
    FORGEPOD_RUN_ID: runId,
  };

  let seq = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let answer = "";
  let error: string | null = null;
  // What a filter refused, in the order it happened. A plugin bound to run.after sees
  // only the calls it blocked itself, and with two filter plugins that is now the normal
  // case, so core passes on what only core saw.
  const blockedCalls: { tool: string; reason: string }[] = [];

  const record = async (step: RunStep) => {
    steps.push(step);
    emit(step);
    await db
      .insertInto("run_steps")
      .values({ run_id: runId, seq: seq++, kind: step.kind, payload: JSON.stringify(step) })
      .execute();
  };

  // Keyed by plugin, not by tool, because a hook handler's plugin is often not one the
  // agent can call, and both go down the same connection when they are the same plugin.
  const launchers = new Map(
    tools.map((t) => [t.pluginName, { manifest: t.manifest, sourceDir: t.sourceDir }]),
  );

  const clientFor = async (pluginName: string): Promise<Client> => {
    const existing = open.get(pluginName);
    if (existing) return existing;

    let launcher = launchers.get(pluginName);
    if (!launcher) {
      const row = await db
        .selectFrom("plugins")
        .select(["manifest", "source_dir"])
        .where("name", "=", pluginName)
        .executeTakeFirst();
      if (!row) throw new Error(`${pluginName} is bound to a hook but is not installed`);
      launcher = {
        manifest: PluginManifest.parse(JSON.parse(row.manifest)),
        sourceDir: row.source_dir,
      };
      launchers.set(pluginName, launcher);
    }

    const opened = await connect(launcher.manifest, { identity, cwd: launcher.sourceDir });
    open.set(pluginName, opened);
    return opened;
  };

  const bindings = await loadBindings(db, version.agentId);
  const context = { runId, agentSlug: version.slug };
  const warn = (text: string) => record({ kind: "note", text });

  /** A handler is an ordinary tool call, so a hook needs nothing a plugin does not have. */
  const invoke: Invoke = async (binding, payload) => {
    const client = await clientFor(binding.pluginName);
    const result = await client.callTool({ name: binding.toolName, arguments: payload });
    // A handler that reports failure has not answered, and for a filter that is the
    // difference between fail-closed and quietly allowing whatever it was asked about.
    if (result.isError === true) throw new Error(String(resultValue(result)));
    return resultValue(result);
  };

  const unavailable = args.unavailable ?? [];
  if (unavailable.length > 0) {
    const named = unavailable.map((t) => `${t.pluginName}.${t.toolName}`).join(", ");
    const count =
      unavailable.length === 1 ? "1 bound tool was" : `${unavailable.length} bound tools were`;
    await record({ kind: "note", text: `${count} unavailable and not offered: ${named}` });
  }

  await fireAction(bindings, "run.before", { ...context, input }, invoke, warn);

  try {
    for (let turn = 0; ; turn++) {
      if (turn >= maxTurns) throw new Error(`stopped after ${maxTurns} turns without an answer`);

      // Re-filtered every turn from the agent's own prompt, so a handler that adds
      // context for one turn does not have it compound over the next.
      const gate = await applyFilter({
        bindings,
        hook: "run.before_provider_call",
        value: version.systemPrompt,
        payloadFor: (system) => ({ ...context, turn, system }),
        invoke,
      });
      if ("blocked" in gate) throw new Error(gate.blocked);
      if (typeof gate.value !== "string") {
        throw new Error("hook run.before_provider_call: a system prompt has to be text");
      }

      const turnResult = await provider.send(
        {
          model: version.model,
          system: gate.value,
          history,
          tools: tools.map((tool) => ({
            name: tool.apiName,
            description: tool.description ?? `${tool.toolName} from ${tool.pluginName}`,
            inputSchema: tool.inputSchema,
          })),
        },
        args.onEvent ? (text) => emit({ kind: "delta", text }) : undefined,
      );

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

        const gate = await applyFilter({
          bindings,
          hook: "tool.before_call",
          value: call.input,
          payloadFor: (input) => ({ ...context, call: { tool: call.name, input } }),
          invoke,
        });

        if ("blocked" in gate) {
          // Two records, because they answer different questions. The note says core
          // stopped the call, and the tool result is what the model is told about it.
          await record({ kind: "note", text: `${call.name} blocked: ${gate.blocked}` });
          blockedCalls.push({ tool: call.name, reason: gate.blocked });
          await record({ kind: "tool_result", tool: call.name, output: gate.blocked, isError: true });
          results.push({ id: call.id, content: gate.blocked, isError: true });
          continue;
        }
        const input = gate.value as Record<string, unknown>;

        const outcome = await (async () => {
          try {
            const result = await (await clientFor(tool.pluginName)).callTool({
              name: tool.toolName,
              arguments: input,
            });
            const output = result.structuredContent ?? result.content;
            return {
              output,
              content: JSON.stringify(output),
              isError: result.isError === true,
            };
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { output: message as unknown, content: message, isError: true };
          }
        })();

        await record({
          kind: "tool_result",
          tool: call.name,
          output: outcome.output,
          isError: outcome.isError,
        });
        results.push({ id: call.id, content: outcome.content, isError: outcome.isError });
        await fireAction(
          bindings,
          "tool.after_call",
          {
            ...context,
            call: { tool: call.name, input },
            result: { output: outcome.output, isError: outcome.isError },
          },
          invoke,
          warn,
        );
      }

      history.push({ role: "assistant", raw: turnResult.raw });
      history.push({ role: "tool_results", results });
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // The closing hooks run after the row is final, so a handler that reads the run back
  // sees what everyone else will, and the plugins stay open until they have all fired.
  try {
    await db
      .updateTable("runs")
      .set({ status: error ? "failed" : "completed", ended_at: now(), error })
      .where("id", "=", runId)
      .execute();

    const status = error ? "failed" : "completed";
    await fireAction(
      bindings,
      "run.after",
      { ...context, status, answer, error, inputTokens, outputTokens, blockedCalls },
      invoke,
      warn,
    );
    if (error) {
      await fireAction(bindings, "run.error", { ...context, error, blockedCalls }, invoke, warn);
    }
  } finally {
    await Promise.all([...open.values()].map((c) => c.close().catch(() => undefined)));
  }

  return { runId, answer, steps, inputTokens, outputTokens, error };
}
