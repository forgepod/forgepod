import { expect, test } from "bun:test";
import { Kysely } from "kysely";
import { DEFAULT_MODEL, listAgents, loadAgent } from "../agents/store";
import { BunSqliteDialect } from "../db/bun-sqlite";
import { migrate } from "../db/migrate";
import type { Schema } from "../db/schema";
import { checkTemplate, installTemplate } from "./install";
import { TemplateManifest } from "./manifest";

const now = "2026-08-24T10:00:00.000Z";

/** A database that has already scanned one plugin publishing one tool. */
async function scannedDb() {
  const db = new Kysely<Schema>({ dialect: new BunSqliteDialect(":memory:") });
  await migrate(db);

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
      scanned_at: now,
      round_trip_ms: 12,
      error: null,
    })
    .execute();

  await db
    .insertInto("plugin_tools")
    .values({
      plugin_name: "beam-mcp",
      name: "beam_reactions",
      description: null,
      input_schema: "{}",
      output_schema: null,
    })
    .execute();

  return db;
}

const manifest = (over: Record<string, unknown> = {}) =>
  TemplateManifest.parse({
    name: "structural-beam",
    version: "0.1.0",
    requires: ["beam-mcp"],
    agents: [
      {
        slug: "beam-checker",
        name: "Beam Checker",
        model: "claude-opus-5",
        systemPrompt: "Check beams.",
        tools: [{ plugin: "beam-mcp", tool: "beam_reactions" }],
      },
      { slug: "load-notes", name: "Load Notes", systemPrompt: "Write load notes." },
    ],
    ...over,
  });

test("a clean install writes every agent with its version, model, prompt and bindings", async () => {
  const db = await scannedDb();

  const ids = await installTemplate(db, manifest(), now);
  expect(ids).toHaveLength(2);

  const bound = await loadAgent(db, ids[0]!);
  expect(bound?.slug).toBe("beam-checker");
  expect(bound?.name).toBe("Beam Checker");
  expect(bound?.version).toBe(1);
  expect(bound?.model).toBe("claude-opus-5");
  expect(bound?.systemPrompt).toBe("Check beams.");
  expect(bound?.tools).toEqual([
    { pluginName: "beam-mcp", toolName: "beam_reactions", available: true },
  ]);

  const plain = await loadAgent(db, ids[1]!);
  expect(plain?.slug).toBe("load-notes");
  // No model in the manifest, so core's default applies rather than a pinned one.
  expect(plain?.model).toBe(DEFAULT_MODEL);
  expect(plain?.tools).toEqual([]);

  await db.destroy();
});

test("a required plugin that was never scanned stops the install", async () => {
  const db = await scannedDb();
  const wanted = manifest({ requires: ["beam-mcp", "absent-mcp"] });

  expect(await checkTemplate(db, wanted)).toEqual([
    { kind: "missing-plugin", plugin: "absent-mcp" },
  ]);
  await expect(installTemplate(db, wanted, now)).rejects.toThrow(/absent-mcp/);
  expect(await listAgents(db)).toEqual([]);

  await db.destroy();
});

test("a tool name that no plugin publishes stops the install", async () => {
  const db = await scannedDb();
  const wanted = manifest({
    agents: [
      {
        slug: "beam-checker",
        name: "Beam Checker",
        systemPrompt: "Check beams.",
        tools: [{ plugin: "beam-mcp", tool: "beam_reaction" }],
      },
    ],
  });

  expect(await checkTemplate(db, wanted)).toEqual([
    { kind: "unknown-tool", plugin: "beam-mcp", tool: "beam_reaction" },
  ]);
  await expect(installTemplate(db, wanted, now)).rejects.toThrow(/beam-mcp\.beam_reaction/);
  expect(await listAgents(db)).toEqual([]);

  await db.destroy();
});

test("a slug already in use stops the whole manifest, not only the colliding agent", async () => {
  const db = await scannedDb();

  await db
    .insertInto("agents")
    .values({
      id: crypto.randomUUID(),
      slug: "load-notes",
      name: "Another Agent",
      created_at: now,
      published_version_id: null,
    })
    .execute();

  await expect(installTemplate(db, manifest(), now)).rejects.toThrow(/load-notes/);

  // Validation completes before the first write, so the agent listed ahead of the
  // collision is never created either.
  const slugs = (await db.selectFrom("agents").select("slug").execute()).map((r) => r.slug);
  expect(slugs).toEqual(["load-notes"]);

  await db.destroy();
});

test("every problem is reported at once, not one per attempt", async () => {
  const db = await scannedDb();

  const problems = await checkTemplate(
    db,
    manifest({
      requires: ["absent-mcp"],
      agents: [
        {
          slug: "beam-checker",
          name: "Beam Checker",
          systemPrompt: "Check beams.",
          tools: [{ plugin: "beam-mcp", tool: "nope" }],
        },
      ],
    }),
  );

  expect(problems).toEqual([
    { kind: "missing-plugin", plugin: "absent-mcp" },
    { kind: "unknown-tool", plugin: "beam-mcp", tool: "nope" },
  ]);

  await db.destroy();
});

test("a missing plugin is reported once, not once per tool bound to it", async () => {
  const db = await scannedDb();
  await db.deleteFrom("plugin_tools").execute();
  await db.deleteFrom("plugins").execute();

  // Two bindings into one absent plugin, and the plugin named in requires as well.
  const problems = await checkTemplate(
    db,
    manifest({
      agents: [
        {
          slug: "beam-checker",
          name: "Beam Checker",
          systemPrompt: "Check beams.",
          tools: [
            { plugin: "beam-mcp", tool: "beam_reactions" },
            { plugin: "beam-mcp", tool: "rectangular_section_modulus" },
          ],
        },
      ],
    }),
  );

  expect(problems).toEqual([{ kind: "missing-plugin", plugin: "beam-mcp" }]);

  await db.destroy();
});

test("a plugin bound to but left out of requires is still reported missing", async () => {
  const db = await scannedDb();

  const problems = await checkTemplate(
    db,
    manifest({
      requires: [],
      agents: [
        {
          slug: "beam-checker",
          name: "Beam Checker",
          systemPrompt: "Check beams.",
          tools: [{ plugin: "absent-mcp", tool: "whatever" }],
        },
      ],
    }),
  );

  expect(problems).toEqual([{ kind: "missing-plugin", plugin: "absent-mcp" }]);

  await db.destroy();
});
