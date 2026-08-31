import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
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
if (!python) console.warn("skipping the approval plugin test: no python3 on PATH");

const usage = { inputTokens: 1, outputTokens: 1 };
const CALL = { id: "call_1", name: "audit-mcp__on_run_after", input: { note: "risky" } };

/** The same two turns twice: ask for the tool, then answer whatever came back. */
function scripted(answer: string): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async send(): Promise<Turn> {
      if (turn++ === 0) {
        return { text: [], toolCalls: [CALL], usage, raw: {}, done: false };
      }
      return { text: [answer], toolCalls: [], usage, raw: {}, done: true };
    },
  };
}

const manifestFor = (name: string) => ({
  name,
  version: "0.1.0",
  transport: "stdio" as const,
  command: python ?? "python3",
  args: ["server.py"],
  state: true,
});

async function install(db: Kysely<Schema>, name: string, tools: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `forgepod-${name}-`));
  await copyFile(`plugins/${name}/server.py`, join(dir, "server.py"));

  await db
    .insertInto("plugins")
    .values({
      name,
      version: "0.1.0",
      description: null,
      transport: "stdio",
      launch: "",
      manifest: JSON.stringify(manifestFor(name)),
      source_dir: dir,
      scanned_at: "2026-08-31T00:00:00.000Z",
      round_trip_ms: null,
      error: null,
    })
    .execute();

  for (const tool of tools) {
    await db
      .insertInto("plugin_tools")
      .values({
        plugin_name: name,
        name: tool,
        description: null,
        input_schema: JSON.stringify({ type: "object" }),
        output_schema: null,
      })
      .execute();
  }
  return dir;
}

test.skipIf(!python)(
  "a call is held for a human, and the next run makes it once it is approved",
  async () => {
    const db = new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });
    await migrate(db);

    const approvalDir = await install(db, "approval-mcp", [
      "on_tool_before_call",
      "list_pending",
      "resolve",
    ]);
    const auditDir = await install(db, "audit-mcp", ["on_run_after"]);

    const agentId = await createAgent(db, { name: "Approved", model: "m" });
    const versionId = await publishVersion(db, agentId, {
      model: "m",
      systemPrompt: "",
      tools: [{ pluginName: "audit-mcp", toolName: "on_run_after" }],
    });

    await trustPlugin(db, "approval-mcp");
    await bindHook(db, {
      agentId,
      hook: "tool.before_call",
      pluginName: "approval-mcp",
      toolName: "on_tool_before_call",
    });

    const version = { id: versionId, agentId, slug: "approved", model: "m", systemPrompt: "" };
    const run = async (answer: string) =>
      runAgent({
        db,
        provider: scripted(answer),
        version,
        tools: await runnableTools(db, versionId),
        input: "log this",
      });

    const held = await run("I have asked for approval.");
    expect(held.error).toBeNull();
    const asked = held.steps.find((s) => s.kind === "tool_result");
    expect(asked).toMatchObject({ tool: "audit-mcp__on_run_after", isError: true });
    expect(String(asked?.output)).toContain("waiting on approval 1");
    // Blocked before the plugin was ever launched, so there is nothing in its log yet.
    await expect(readFile(join(auditDir, "state", "audit.jsonl"), "utf8")).rejects.toThrow();

    // What the operator's screen will call: the same tools, over the same transport.
    const client = await connect(manifestFor("approval-mcp"), {
      cwd: approvalDir,
      container: false,
    });
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      resultValue(await client.callTool({ name, arguments: args })) as Record<string, unknown>;

    const pending = (await call("list_pending")).pending as Record<string, unknown>[];
    expect(pending).toMatchObject([
      { id: 1, agent: "approved", tool: "audit-mcp__on_run_after", input: { note: "risky" } },
    ]);
    expect(await call("resolve", { id: 1, decision: "allow_once" })).toEqual({
      id: 1,
      status: "approved",
    });
    // An answer is given once. Answering it again is reported as a tool error, which is
    // what core reads as a handler that did not answer.
    const twice = await client.callTool({
      name: "resolve",
      arguments: { id: 1, decision: "refuse" },
    });
    expect(twice.isError).toBe(true);

    const allowed = await run("Logged.");
    expect(allowed.error).toBeNull();
    expect(allowed.answer).toBe("Logged.");
    const result = allowed.steps.find((s) => s.kind === "tool_result");
    expect(result).toMatchObject({ tool: "audit-mcp__on_run_after", isError: false });

    // The tool really ran this time, and the approval is spent rather than standing.
    const written = await readFile(join(auditDir, "state", "audit.jsonl"), "utf8");
    expect(JSON.parse(written.trim())).toMatchObject({ note: "risky" });
    expect((await call("list_pending")).pending).toEqual([]);

    await client.close();
    await db.destroy();
  },
  60_000,
);
