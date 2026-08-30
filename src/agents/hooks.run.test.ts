import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../db/bun-sqlite";
import { migrate } from "../db/migrate";
import type { Schema } from "../db/schema";
import { bindHook, trustPlugin } from "./hooks";
import type { Provider, Turn } from "./provider";
import { runAgent, runnableTools } from "./run";
import { createAgent, publishVersion } from "./store";

// The reference plugin needs no third-party package, so this runs without a container
// runtime and without an image. That is the point: it is the same server.py the image
// would run.
const python = Bun.which("python3");
if (!python) console.warn("skipping the hook plugin test: no python3 on PATH");

const usage = { inputTokens: 1, outputTokens: 1 };

/** Two turns: call the plugin's tool, then answer. Enough to reach every hook point. */
function scripted(): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async send(): Promise<Turn> {
      if (turn++ === 0) {
        return {
          text: [],
          toolCalls: [
            { id: "call_1", name: "audit-mcp__on_run_after", input: { note: "from the model" } },
          ],
          usage,
          raw: {},
          done: false,
        };
      }
      return { text: ["Logged."], toolCalls: [], usage, raw: {}, done: true };
    },
  };
}

test.skipIf(!python)(
  "a bound plugin is launched, filters the tool call and records the finished run",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "forgepod-audit-"));
    await copyFile("plugins/audit-mcp/server.py", join(dir, "server.py"));

    const db = new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });
    await migrate(db);

    const manifest = {
      name: "audit-mcp",
      version: "0.1.0",
      transport: "stdio",
      command: python,
      args: ["server.py"],
      state: true,
    };
    await db
      .insertInto("plugins")
      .values({
        name: "audit-mcp",
        version: "0.1.0",
        description: null,
        transport: "stdio",
        launch: "",
        manifest: JSON.stringify(manifest),
        source_dir: dir,
        scanned_at: "2026-08-30T00:00:00.000Z",
        round_trip_ms: null,
        error: null,
      })
      .execute();

    for (const name of ["on_run_after", "on_tool_before_call"]) {
      await db
        .insertInto("plugin_tools")
        .values({
          plugin_name: "audit-mcp",
          name,
          description: null,
          input_schema: JSON.stringify({ type: "object" }),
          output_schema: null,
        })
        .execute();
    }

    const agentId = await createAgent(db, { name: "Audited", model: "m" });
    const versionId = await publishVersion(db, agentId, {
      model: "m",
      systemPrompt: "",
      tools: [{ pluginName: "audit-mcp", toolName: "on_run_after" }],
    });

    await trustPlugin(db, "audit-mcp");
    await bindHook(db, {
      agentId,
      hook: "tool.before_call",
      pluginName: "audit-mcp",
      toolName: "on_tool_before_call",
    });
    await bindHook(db, {
      agentId,
      hook: "run.after",
      pluginName: "audit-mcp",
      toolName: "on_run_after",
    });

    const outcome = await runAgent({
      db,
      provider: scripted(),
      version: { id: versionId, agentId, slug: "audited", model: "m", systemPrompt: "" },
      tools: await runnableTools(db, versionId),
      input: "log this",
    });

    expect(outcome.error).toBeNull();
    expect(outcome.answer).toBe("Logged.");
    // Nothing was blocked and no handler failed, so core wrote no note about either.
    expect(outcome.steps.filter((s) => s.kind === "note")).toEqual([]);

    const written = await readFile(join(dir, "state", "audit.jsonl"), "utf8");
    const lines = written.trim().split("\n").map((line) => JSON.parse(line));

    // The filter saw the call before it ran, the tool itself ran, and the run.after hook
    // fired once the row was final. The handler is reached the same way the tool is.
    expect(lines.map((l) => l.hook ?? null)).toEqual(["tool.before_call", null, "run.after"]);
    expect(lines[0].call).toEqual({ tool: "audit-mcp__on_run_after", input: { note: "from the model" } });
    expect(lines[2]).toMatchObject({ runId: outcome.runId, agentSlug: "audited", status: "completed" });

    await db.destroy();
  },
  60_000,
);
