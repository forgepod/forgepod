import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { Kysely, PGliteDialect } from "kysely";
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
