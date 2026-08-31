import { expect, test } from "bun:test";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../db/bun-sqlite";
import { migrate } from "../db/migrate";
import type { Schema } from "../db/schema";
import { approvalPlugins, pendingApprovals, resolveApproval } from "./approvals";
import { connect } from "./mcp";

const python = Bun.which("python3");
if (!python) console.warn("skipping the approvals test: no python3 on PATH");

test.skipIf(!python)("the admin reads and answers what a plugin is holding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forgepod-approvals-"));
  await copyFile("plugins/approval-mcp/server.py", join(dir, "server.py"));

  const manifest = {
    name: "approval-mcp",
    version: "0.1.0",
    transport: "stdio" as const,
    command: python ?? "python3",
    args: ["server.py"],
    state: true,
  };

  const db = new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });
  await migrate(db);
  await db
    .insertInto("plugins")
    .values({
      name: "approval-mcp",
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

  for (const name of ["on_tool_before_call", "list_pending", "resolve"]) {
    await db
      .insertInto("plugin_tools")
      .values({
        plugin_name: "approval-mcp",
        name,
        description: null,
        input_schema: JSON.stringify({ type: "object" }),
        output_schema: null,
      })
      .execute();
  }

  // Found by the pair of tools it publishes. Core never learns the plugin's name.
  expect(await approvalPlugins(db)).toEqual(["approval-mcp"]);

  const client = await connect(manifest, { cwd: dir, container: false });
  await client.callTool({
    name: "on_tool_before_call",
    arguments: {
      runId: "run-1",
      agentSlug: "clerk",
      call: { tool: "files-mcp__write", input: { path: "lama.txt" } },
    },
  });
  await client.close();

  const pending = await pendingApprovals(db, "run-1");
  expect(pending).toMatchObject([
    { plugin: "approval-mcp", id: 1, agent: "clerk", tool: "files-mcp__write", runId: "run-1" },
  ]);
  // The card belongs to the run the call was refused in, and to no other.
  expect(await pendingApprovals(db, "run-2")).toEqual([]);

  await resolveApproval(db, "approval-mcp", 1, "allow_once");
  expect(await pendingApprovals(db, "run-1")).toEqual([]);
  expect(resolveApproval(db, "approval-mcp", 1, "allow_once")).rejects.toThrow();

  await db.destroy();
}, 60_000);
