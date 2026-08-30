import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { Kysely, PGliteDialect } from "kysely";
import { bindHook, listBindings, trustPlugin } from "../agents/hooks";
import type { Inspection } from "../plugins/registry";
import { loadPlugins, saveScan } from "../plugins/store";
import { BunSqliteDialect } from "./bun-sqlite";
import { migrate } from "./migrate";
import type { Schema } from "./schema";

const scannedAt = "2026-08-24T09:00:00.000Z";

const scan: Inspection[] = [
  {
    dir: "plugins/beam-mcp",
    manifest: {
      transport: "stdio",
      name: "beam-mcp",
      version: "0.1.0",
      description: "Statics for a simply supported beam.",
      command: ".venv/bin/python",
      args: ["server.py"],
      image: "forgepod/beam-mcp:0.1.0",
    },
    launch: "podman run --rm -i forgepod/beam-mcp:0.1.0",
    ms: 1558,
    tools: [
      {
        name: "beam_reactions",
        description: "Support reactions.",
        inputSchema: { type: "object", properties: { span_m: { type: "number" } } },
        outputSchema: { type: "object", properties: { reaction_left_kn: { type: "number" } } },
      },
    ],
  },
  {
    dir: "plugins/broken",
    manifest: { transport: "http", name: "broken", version: "0.0.1", url: "http://localhost:9/mcp" },
    launch: "http://localhost:9/mcp",
    error: "connection refused",
  },
];

async function roundTrip(db: Kysely<Schema>) {
  await migrate(db);
  await saveScan(db, scan, scannedAt);
  const stored = await loadPlugins(db);

  // A plugin removed from disk must vanish on the next scan, not linger.
  await saveScan(db, scan.slice(0, 1), scannedAt);
  const afterRemoval = await loadPlugins(db);

  await db.destroy();
  return { stored, afterRemoval };
}

test("one schema and one set of queries serve both sqlite and postgres", async () => {
  const sqlite = await roundTrip(new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") }));
  const postgres = await roundTrip(
    new Kysely<Schema>({ dialect: new PGliteDialect({ pglite: new PGlite() }) }),
  );

  expect(sqlite).toEqual(postgres);

  expect(sqlite.stored.map((p) => p.name)).toEqual(["beam-mcp", "broken"]);
  expect(sqlite.stored[0]?.tools.map((t) => t.name)).toEqual(["beam_reactions"]);
  expect(sqlite.stored[0]?.roundTripMs).toBe(1558);
  expect(sqlite.stored[1]?.error).toBe("connection refused");
  expect(sqlite.stored[1]?.tools).toEqual([]);

  expect(sqlite.afterRemoval.map((p) => p.name)).toEqual(["beam-mcp"]);
}, 60_000);

test("json schemas survive the round trip as objects, not as strings", async () => {
  const db = new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });
  await migrate(db);
  await saveScan(db, scan, scannedAt);

  const tool = (await loadPlugins(db))[0]?.tools[0];
  expect(tool?.outputSchema).toEqual({
    type: "object",
    properties: { reaction_left_kn: { type: "number" } },
  });

  await db.destroy();
});

async function hookRoundTrip(db: Kysely<Schema>) {
  await migrate(db);
  await db
    .insertInto("agents")
    .values({
      id: "agent_1",
      slug: "beam-checker",
      name: "Beam checker",
      created_at: scannedAt,
      published_version_id: null,
    })
    .execute();

  await trustPlugin(db, "guard-mcp");
  await bindHook(
    db,
    { agentId: "agent_1", hook: "tool.before_call", pluginName: "guard-mcp", toolName: "on_call", priority: 1 },
    scannedAt,
  );
  await bindHook(
    db,
    { agentId: null, hook: "run.after", pluginName: "audit-mcp", toolName: "on_run_after" },
    scannedAt,
  );

  // The id is generated per row, so it cannot take part in the comparison.
  const bindings = (await listBindings(db, "agent_1")).map(({ id, ...rest }) => rest);
  const trusted = await db.selectFrom("settings").selectAll().orderBy("key").execute();

  await db.destroy();
  return { bindings, trusted };
}

test("hook bindings and plugin trust read back the same on both dialects", async () => {
  const sqlite = await hookRoundTrip(
    new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") }),
  );
  const postgres = await hookRoundTrip(
    new Kysely<Schema>({ dialect: new PGliteDialect({ pglite: new PGlite() }) }),
  );

  expect(sqlite).toEqual(postgres);
  expect(sqlite.bindings.map((b) => b.hook)).toEqual(["tool.before_call", "run.after"]);
  expect(sqlite.bindings[1]?.agentId).toBeNull();
  expect(sqlite.trusted).toEqual([{ key: "plugin_trust:guard-mcp", value: "trusted" }]);
}, 60_000);
