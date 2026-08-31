import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../db/bun-sqlite";
import { migrate } from "../db/migrate";
import type { Schema } from "../db/schema";
import { connect, resultValue } from "../plugins/mcp";
import { bindHook, trustPlugin } from "./hooks";
import type { Provider, Turn } from "./provider";
import { runAgent, runnableTools } from "./run";
import { createAgent, publishVersion } from "./store";

const python = Bun.which("python3");
if (!python) console.warn("skipping the guard plugin test: no python3 on PATH");

const usage = { inputTokens: 1, outputTokens: 1 };

const manifest = {
  name: "guard-mcp",
  version: "0.1.0",
  transport: "stdio" as const,
  command: python ?? "python3",
  args: ["server.py"],
  state: true,
};

/** Copy of the shipped handler, plus the rules an operator would have written. */
async function install(rules: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "forgepod-guard-"));
  await copyFile("plugins/guard-mcp/server.py", join(dir, "server.py"));
  await mkdir(join(dir, "state"), { recursive: true });
  await writeFile(join(dir, "state", "rules.json"), JSON.stringify(rules));
  return dir;
}

/** One tool call the operator forbade, then an answer once the model is told why. */
function scripted(): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async send(): Promise<Turn> {
      if (turn++ === 0) {
        return {
          text: [],
          toolCalls: [{ id: "call_1", name: "files-mcp__write", input: { path: "/etc/passwd" } }],
          usage,
          raw: {},
          done: false,
        };
      }
      return { text: ["I am not allowed to write here."], toolCalls: [], usage, raw: {}, done: true };
    },
  };
}

test.skipIf(!python)(
  "a forbidden tool is refused, the model is told why, and the run finishes",
  async () => {
    const dir = await install({ rules: [{ tool: "files-mcp__write", block: "read-only install" }] });

    const db = new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });
    await migrate(db);

    await db
      .insertInto("plugins")
      .values({
        name: "guard-mcp",
        version: "0.1.0",
        description: null,
        transport: "stdio",
        launch: "",
        manifest: JSON.stringify(manifest),
        source_dir: dir,
        scanned_at: "2026-08-31T00:00:00.000Z",
        round_trip_ms: null,
        error: null,
      })
      .execute();
    await db
      .insertInto("plugin_tools")
      .values({
        plugin_name: "guard-mcp",
        name: "on_tool_before_call",
        description: null,
        input_schema: JSON.stringify({ type: "object" }),
        output_schema: null,
      })
      .execute();

    // The forbidden tool is never launched, so its plugin only has to exist as a row.
    // A command that cannot start is deliberate: if the guard let the call through, the
    // failure would say so rather than quietly passing.
    await db
      .insertInto("plugins")
      .values({
        name: "files-mcp",
        version: "0.1.0",
        description: null,
        transport: "stdio",
        launch: "",
        manifest: JSON.stringify({
          name: "files-mcp",
          version: "0.1.0",
          transport: "stdio",
          command: "forgepod-no-such-binary",
          args: [],
        }),
        source_dir: dir,
        scanned_at: "2026-08-31T00:00:00.000Z",
        round_trip_ms: null,
        error: null,
      })
      .execute();
    await db
      .insertInto("plugin_tools")
      .values({
        plugin_name: "files-mcp",
        name: "write",
        description: null,
        input_schema: JSON.stringify({ type: "object" }),
        output_schema: null,
      })
      .execute();

    const agentId = await createAgent(db, { name: "Guarded", model: "m" });
    const versionId = await publishVersion(db, agentId, {
      model: "m",
      systemPrompt: "",
      tools: [{ pluginName: "files-mcp", toolName: "write" }],
    });

    // audit-mcp is here to read the run.after payload back, since a filter plugin sees
    // only what it blocked itself and the point of blockedCalls is that core saw it all.
    const auditDir = await mkdtemp(join(tmpdir(), "forgepod-guard-audit-"));
    await copyFile("plugins/audit-mcp/server.py", join(auditDir, "server.py"));
    await db
      .insertInto("plugins")
      .values({
        name: "audit-mcp",
        version: "0.1.0",
        description: null,
        transport: "stdio",
        launch: "",
        manifest: JSON.stringify({ ...manifest, name: "audit-mcp" }),
        source_dir: auditDir,
        scanned_at: "2026-08-31T00:00:00.000Z",
        round_trip_ms: null,
        error: null,
      })
      .execute();
    await db
      .insertInto("plugin_tools")
      .values({
        plugin_name: "audit-mcp",
        name: "on_run_after",
        description: null,
        input_schema: JSON.stringify({ type: "object" }),
        output_schema: null,
      })
      .execute();
    await bindHook(db, {
      agentId,
      hook: "run.after",
      pluginName: "audit-mcp",
      toolName: "on_run_after",
    });

    await trustPlugin(db, "guard-mcp");
    await bindHook(db, {
      agentId,
      hook: "tool.before_call",
      pluginName: "guard-mcp",
      toolName: "on_tool_before_call",
    });

    const outcome = await runAgent({
      db,
      provider: scripted(),
      version: { id: versionId, agentId, slug: "guarded", model: "m", systemPrompt: "" },
      tools: await runnableTools(db, versionId),
      input: "write to /etc/passwd",
    });

    const refusal = outcome.steps.find((s) => s.kind === "tool_result");
    expect(refusal).toMatchObject({ tool: "files-mcp__write", isError: true });
    expect(String(refusal?.output)).toContain("read-only install");
    // Blocked, not failed: the model gets the reason and keeps going.
    expect(outcome.error).toBeNull();
    expect(outcome.answer).toBe("I am not allowed to write here.");

    // A handler on run.after is told what was refused, without reading the transcript.
    const logged = JSON.parse(await readFile(join(auditDir, "state", "audit.jsonl"), "utf8"));
    expect(logged.blockedCalls).toEqual([
      { tool: "files-mcp__write", reason: "files-mcp__write is not allowed here: read-only install" },
    ]);

    await db.destroy();
  },
  60_000,
);

test.skipIf(!python)("a tool that keeps failing ends the run rather than looping", async () => {
  const dir = await install({ rules: [{ tool: "*", maxConsecutiveFailures: 3, maxInputBytes: 40 }] });
  const client = await connect(manifest, { cwd: dir, container: false });

  const call = async (name: string, args: Record<string, unknown>) =>
    resultValue(await client.callTool({ name, arguments: args }));

  const failed = (runId: string, tool: string) =>
    call("on_tool_after_call", { runId, call: { tool }, result: { isError: true } });
  const gate = (runId: string) => call("on_before_provider_call", { runId });

  await failed("run-1", "beam-mcp__deflection");
  await failed("run-1", "beam-mcp__deflection");
  expect(await gate("run-1")).toEqual({ action: "allow" });

  expect(await failed("run-1", "beam-mcp__deflection")).toEqual({
    tool: "beam-mcp__deflection",
    consecutiveFailures: 3,
  });
  expect(await gate("run-1")).toMatchObject({ action: "block" });

  // Another run's failures are its own, and a call that works clears the count.
  expect(await gate("run-2")).toEqual({ action: "allow" });
  await call("on_tool_after_call", {
    runId: "run-1",
    call: { tool: "beam-mcp__deflection" },
    result: { isError: false },
  });
  expect(await gate("run-1")).toEqual({ action: "allow" });

  // The size ceiling is measured on the input core is about to pass, not on the payload.
  expect(
    await call("on_tool_before_call", {
      runId: "run-1",
      call: { tool: "beam-mcp__deflection", input: { note: "x".repeat(100) } },
    }),
  ).toMatchObject({ action: "block" });

  await client.close();
}, 60_000);
