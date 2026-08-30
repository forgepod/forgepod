import { expect, test } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../db/bun-sqlite";
import { migrate } from "../db/migrate";
import type { Schema } from "../db/schema";
import {
  applyFilter,
  bindHook,
  fireAction,
  listBindings,
  loadBindings,
  trustPlugin,
  type Bindings,
  type Invoke,
} from "./hooks";

async function fresh(): Promise<Kysely<Schema>> {
  const db = new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });
  await migrate(db);
  return db;
}

async function agent(db: Kysely<Schema>, slug: string): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .insertInto("agents")
    .values({
      id,
      slug,
      name: slug,
      created_at: "2026-08-30T00:00:00.000Z",
      published_version_id: null,
    })
    .execute();
  return id;
}

/** What core does when a handler answers, without launching anything to hear it. */
const answering = (replies: Record<string, unknown>) => {
  const seen: Array<{ tool: string; payload: Record<string, unknown> }> = [];
  const invoke: Invoke = async (binding, payload) => {
    seen.push({ tool: binding.toolName, payload });
    const reply = replies[binding.toolName];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { invoke, seen };
};

const bound = (...tools: string[]): Bindings => {
  const list = tools.map((toolName) => ({
    hook: "run.after" as const,
    pluginName: "p",
    toolName,
  }));
  return () => list;
};

test("actions fire in order, and one that fails is reported without stopping the rest", async () => {
  const { invoke, seen } = answering({ first: { ok: true }, broken: new Error("down"), last: {} });
  const warnings: string[] = [];

  await fireAction(
    bound("first", "broken", "last"),
    "run.after",
    { runId: "run_1" },
    invoke,
    (text) => void warnings.push(text),
  );

  expect(seen.map((s) => s.tool)).toEqual(["first", "broken", "last"]);
  expect(seen[0]?.payload).toEqual({ hook: "run.after", runId: "run_1" });
  expect(warnings).toEqual(["hook run.after: p.broken failed: down"]);
});

test("a filter chain hands each answer to the next handler", async () => {
  const { invoke, seen } = answering({
    redact: { action: "modify", value: { text: "[redacted]" } },
    watch: { action: "allow" },
  });

  const outcome = await applyFilter({
    bindings: () => [
      { hook: "tool.before_call", pluginName: "p", toolName: "redact" },
      { hook: "tool.before_call", pluginName: "p", toolName: "watch" },
    ],
    hook: "tool.before_call",
    value: { text: "my card is 4111 1111 1111 1111" },
    payloadFor: (input) => ({ call: { tool: "notes__write", input } }),
    invoke,
  });

  expect(outcome).toEqual({ value: { text: "[redacted]" } });
  // The second handler is asked about what the first returned, not about the original.
  expect(seen[1]?.payload).toEqual({
    hook: "tool.before_call",
    call: { tool: "notes__write", input: { text: "[redacted]" } },
  });
});

test("a block ends the chain and nothing after it is asked", async () => {
  const { invoke, seen } = answering({
    approval: { action: "block", reason: "waiting for a human" },
    watch: { action: "allow" },
  });

  const outcome = await applyFilter({
    bindings: () => [
      { hook: "tool.before_call", pluginName: "p", toolName: "approval" },
      { hook: "tool.before_call", pluginName: "p", toolName: "watch" },
    ],
    hook: "tool.before_call",
    value: { amount: 500 },
    payloadFor: (input) => ({ input }),
    invoke,
  });

  expect(outcome).toEqual({ blocked: "waiting for a human" });
  expect(seen.map((s) => s.tool)).toEqual(["approval"]);
});

test("a handler that cannot answer blocks, because silence is not consent", async () => {
  const failed = await applyFilter({
    bindings: () => [{ hook: "tool.before_call", pluginName: "p", toolName: "crashed" }],
    hook: "tool.before_call",
    value: {},
    payloadFor: () => ({}),
    invoke: answering({ crashed: new Error("container exited") }).invoke,
  });
  expect(failed).toEqual({ blocked: "hook tool.before_call: p.crashed did not answer: container exited" });

  const nonsense = await applyFilter({
    bindings: () => [{ hook: "tool.before_call", pluginName: "p", toolName: "confused" }],
    hook: "tool.before_call",
    value: {},
    payloadFor: () => ({}),
    invoke: answering({ confused: "sure, go ahead" }).invoke,
  });
  expect("blocked" in nonsense).toBe(true);

  const empty = await applyFilter({
    bindings: () => [{ hook: "tool.before_call", pluginName: "p", toolName: "half" }],
    hook: "tool.before_call",
    value: { a: 1 },
    payloadFor: () => ({}),
    invoke: answering({ half: { action: "modify" } }).invoke,
  });
  expect(empty).toEqual({ blocked: "hook tool.before_call: p.half asked to modify without a value" });
});

test("a plugin has to be trusted before it can bind to a filter", async () => {
  const db = await fresh();
  const id = await agent(db, "beam-checker");

  // An action is open to anyone: the worst it can do is fail and be noted.
  await bindHook(db, { agentId: id, hook: "run.after", pluginName: "audit-mcp", toolName: "on_run_after" });

  expect(
    bindHook(db, {
      agentId: id,
      hook: "tool.before_call",
      pluginName: "audit-mcp",
      toolName: "on_tool_before_call",
    }),
  ).rejects.toThrow(/has to be trusted/);

  await trustPlugin(db, "audit-mcp");
  await bindHook(db, {
    agentId: id,
    hook: "tool.before_call",
    pluginName: "audit-mcp",
    toolName: "on_tool_before_call",
  });

  expect((await listBindings(db, id)).map((b) => b.hook)).toEqual(["run.after", "tool.before_call"]);

  // Withdrawn again, and what is already bound is not silently revoked: an operator who
  // wants it gone unbinds it, so the change is one they can see.
  await trustPlugin(db, "audit-mcp", false);
  expect((await listBindings(db, id)).length).toBe(2);

  await db.destroy();
});

test("a run sees its own bindings and the install-wide ones, never another agent's", async () => {
  const db = await fresh();
  const mine = await agent(db, "mine");
  const theirs = await agent(db, "theirs");

  await bindHook(db, { agentId: null, hook: "run.after", pluginName: "audit-mcp", toolName: "everywhere" });
  await bindHook(db, { agentId: mine, hook: "run.after", pluginName: "audit-mcp", toolName: "ours", priority: 1 });
  await bindHook(db, { agentId: theirs, hook: "run.after", pluginName: "audit-mcp", toolName: "not-ours" });

  const bindings = await loadBindings(db, mine);
  // Priority orders them, so a redaction filter can be made to run before an approval one.
  expect(bindings("run.after").map((b) => b.toolName)).toEqual(["ours", "everywhere"]);
  expect(bindings("tool.before_call")).toEqual([]);

  await db.destroy();
});
