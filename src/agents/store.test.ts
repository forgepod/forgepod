import { expect, test } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../db/bun-sqlite";
import { migrate } from "../db/migrate";
import type { Schema } from "../db/schema";
import { DEFAULT_MODEL, createAgent, loadAgent, publishVersion } from "./store";

const at = "2026-08-24T10:00:00.000Z";

/** A scanned plugin publishing exactly the tools named. */
async function publish(db: Kysely<Schema>, tools: string[]) {
  await db.deleteFrom("plugin_tools").execute();
  await db.deleteFrom("plugins").execute();

  if (tools.length === 0) return;

  await db
    .insertInto("plugins")
    .values({
      name: "beam-mcp",
      version: "0.1.0",
      description: null,
      transport: "stdio",
      launch: "docker run --rm -i forgepod/beam-mcp:0.1.0",
      manifest: "{}",
      source_dir: "plugins/beam-mcp",
      scanned_at: at,
      round_trip_ms: 12,
      error: null,
    })
    .execute();

  for (const name of tools) {
    await db
      .insertInto("plugin_tools")
      .values({
        plugin_name: "beam-mcp",
        name,
        description: null,
        input_schema: "{}",
        output_schema: null,
      })
      .execute();
  }
}

/** An agent bound to both beam tools, at a moment when both of them exist. */
async function boundAgent() {
  const db = new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });
  await migrate(db);
  await publish(db, ["beam_reactions", "rectangular_section_modulus"]);

  const id = await createAgent(db, { name: "Beam Checker" }, at);
  await publishVersion(
    db,
    id,
    {
      model: "claude-opus-5",
      systemPrompt: "Check beams.",
      tools: [
        { pluginName: "beam-mcp", toolName: "beam_reactions" },
        { pluginName: "beam-mcp", toolName: "rectangular_section_modulus" },
      ],
    },
    at,
  );

  return { db, id };
}

test("a binding whose tool is still published is available", async () => {
  const { db, id } = await boundAgent();

  const agent = await loadAgent(db, id);
  expect(agent?.tools.map((t) => t.available)).toEqual([true, true]);

  await db.destroy();
});

test("a plugin upgrade that renames a tool leaves the binding declared and unavailable", async () => {
  const { db, id } = await boundAgent();

  // The plugin ships a new version in which one tool has a different name. The binding
  // survives the rescan on purpose: a plugin that is briefly down must not erase an
  // agent's configuration.
  await publish(db, ["beam_reactions", "section_modulus_rect"]);

  const agent = await loadAgent(db, id);
  expect(agent?.tools).toHaveLength(2);
  expect(agent?.tools.find((t) => t.toolName === "beam_reactions")?.available).toBe(true);
  expect(agent?.tools.find((t) => t.toolName === "rectangular_section_modulus")?.available).toBe(
    false,
  );

  await db.destroy();
});

test("a plugin removed from disk leaves every one of its bindings unavailable", async () => {
  const { db, id } = await boundAgent();

  await publish(db, []);

  const agent = await loadAgent(db, id);
  expect(agent?.tools.map((t) => t.available)).toEqual([false, false]);

  await db.destroy();
});

/** No plugins scanned, so nothing here is about bindings. */
async function freshDb() {
  const db = new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });
  await migrate(db);
  return db;
}

test("a new agent arrives with its first version already published", async () => {
  const db = await freshDb();

  const id = await createAgent(db, { name: "Keeper" }, at);
  const agent = await loadAgent(db, id);

  expect(agent?.slug).toBe("keeper");
  expect(agent?.version).toBe(1);
  expect(agent?.model).toBe(DEFAULT_MODEL);
  expect(agent?.tools).toEqual([]);

  await db.destroy();
});

test("a version published inside a caller's transaction rolls back with it", async () => {
  const db = await freshDb();
  const id = await createAgent(db, { name: "Keeper" }, at);

  await expect(
    db.transaction().execute(async (trx) => {
      await publishVersion(trx, id, { model: "other", systemPrompt: "second", tools: [] }, at);
      throw new Error("the caller failed after publishing");
    }),
  ).rejects.toThrow("the caller failed after publishing");

  // The rollback has to reach the new version and the pointer that was moved to it.
  const agent = await loadAgent(db, id);
  expect(agent?.version).toBe(1);
  expect(agent?.model).toBe(DEFAULT_MODEL);
  expect(agent?.systemPrompt).toBe("");

  await db.destroy();
});

test("publishing again outside a transaction still increments the version", async () => {
  const db = await freshDb();
  const id = await createAgent(db, { name: "Keeper" }, at);

  await publishVersion(db, id, { model: "other", systemPrompt: "second", tools: [] }, at);
  const agent = await loadAgent(db, id);

  expect(agent?.version).toBe(2);
  expect(agent?.systemPrompt).toBe("second");

  await db.destroy();
});
