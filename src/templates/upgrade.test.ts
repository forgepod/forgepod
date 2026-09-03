import { expect, test } from "bun:test";
import { Kysely } from "kysely";
import { loadAgent, publishVersion } from "../agents/store";
import { BunSqliteDialect } from "../db/bun-sqlite";
import { migrate } from "../db/migrate";
import type { Schema } from "../db/schema";
import { installTemplate } from "./install";
import { TemplateManifest } from "./manifest";
import { applyUpgrade, planUpgrade } from "./upgrade";

const now = "2026-09-03T10:00:00.000Z";
const later = "2026-09-03T11:00:00.000Z";

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

const agent = (slug: string, prompt: string, tools: { plugin: string; tool: string }[] = []) => ({
  slug,
  name: slug,
  model: "claude-opus-5",
  systemPrompt: prompt,
  tools,
});

const manifest = (version: string, agents: unknown[]) =>
  TemplateManifest.parse({
    name: "structural-beam",
    version,
    requires: ["beam-mcp"],
    agents,
  });

const v1 = () =>
  manifest("0.1.0", [
    agent("beam-checker", "Check beams.", [{ plugin: "beam-mcp", tool: "beam_reactions" }]),
    agent("load-notes", "Write load notes."),
  ]);

const kinds = (changes: { kind: string; slug: string }[]) =>
  changes.map((c) => `${c.slug}:${c.kind}`).sort();

const promptOf = async (db: Kysely<Schema>, slug: string) => {
  const row = await db.selectFrom("agents").select("id").where("slug", "=", slug).executeTakeFirstOrThrow();
  return (await loadAgent(db, row.id))!;
};

const recorded = (db: Kysely<Schema>) =>
  db
    .selectFrom("template_installs")
    .innerJoin("agents", "agents.id", "template_installs.agent_id")
    .select(["agents.slug as slug", "template_installs.installed_version as version"])
    .orderBy("agents.slug")
    .execute();

test("installing records one row per agent, holding what the template wrote", async () => {
  const db = await scannedDb();
  await installTemplate(db, v1(), now);

  expect(await recorded(db)).toEqual([
    { slug: "beam-checker", version: "0.1.0" },
    { slug: "load-notes", version: "0.1.0" },
  ]);
});

test("an untouched agent moves up, and one edited since install is left exactly as the operator left it", async () => {
  const db = await scannedDb();
  await installTemplate(db, v1(), now);

  // The operator tunes one agent, which is the case the whole stopping rule exists for.
  const tuned = await promptOf(db, "load-notes");
  await publishVersion(db, tuned.id, {
    model: tuned.model,
    systemPrompt: "Write load notes, in metric units only.",
    tools: [],
  });

  const next = manifest("0.2.0", [
    agent("beam-checker", "Check beams, and state the span first.", [
      { plugin: "beam-mcp", tool: "beam_reactions" },
    ]),
    agent("load-notes", "Write load notes, revised."),
  ]);

  const { changes, problems } = await planUpgrade(db, next);
  expect(problems).toEqual([]);
  expect(kinds(changes)).toEqual(["beam-checker:update", "load-notes:edited"]);

  await applyUpgrade(db, next, later);

  expect((await promptOf(db, "beam-checker")).systemPrompt).toBe("Check beams, and state the span first.");
  expect((await promptOf(db, "load-notes")).systemPrompt).toBe("Write load notes, in metric units only.");

  // The skipped agent keeps its own recorded version, which is why the row is per agent.
  expect(await recorded(db)).toEqual([
    { slug: "beam-checker", version: "0.2.0" },
    { slug: "load-notes", version: "0.1.0" },
  ]);
});

test("an agent added by a newer version is created, and one dropped from it is left standing", async () => {
  const db = await scannedDb();
  await installTemplate(db, v1(), now);

  const next = manifest("0.2.0", [
    agent("beam-checker", "Check beams.", [{ plugin: "beam-mcp", tool: "beam_reactions" }]),
    agent("deflection-notes", "Check deflection."),
  ]);

  const { changes } = await planUpgrade(db, next);
  expect(kinds(changes)).toEqual([
    "beam-checker:update",
    "deflection-notes:create",
    "load-notes:orphan",
  ]);

  await applyUpgrade(db, next, later);

  expect((await promptOf(db, "deflection-notes")).version).toBe(1);
  expect((await promptOf(db, "load-notes")).systemPrompt).toBe("Write load notes.");
  expect(await recorded(db)).toEqual([
    { slug: "beam-checker", version: "0.2.0" },
    { slug: "deflection-notes", version: "0.2.0" },
    { slug: "load-notes", version: "0.1.0" },
  ]);
});

test("a new template version that changes nothing restamps the row without publishing a version", async () => {
  const db = await scannedDb();
  await installTemplate(db, v1(), now);

  const same = manifest("0.2.0", v1().agents);
  const { changes } = await planUpgrade(db, same);
  expect(changes.every((c) => c.kind === "update" && !c.republish)).toBe(true);

  await applyUpgrade(db, same, later);

  expect((await promptOf(db, "beam-checker")).version).toBe(1);
  expect(await recorded(db)).toEqual([
    { slug: "beam-checker", version: "0.2.0" },
    { slug: "load-notes", version: "0.2.0" },
  ]);

  // Second time round there is nothing left to do at all.
  expect((await planUpgrade(db, same)).changes.every((c) => c.kind === "unchanged")).toBe(true);
});

test("a template that was never installed here cannot be upgraded into existence", async () => {
  const db = await scannedDb();

  await expect(planUpgrade(db, v1())).rejects.toThrow("has never been installed here");
});

test("a plugin the newer version needs but the install does not have blocks the whole upgrade", async () => {
  const db = await scannedDb();
  await installTemplate(db, v1(), now);

  const next = manifest("0.2.0", [
    agent("beam-checker", "Check beams.", [{ plugin: "absent-mcp", tool: "whatever" }]),
    agent("load-notes", "Write load notes."),
  ]);

  await expect(applyUpgrade(db, next, later)).rejects.toThrow("plugin not installed or not scanned: absent-mcp");
  expect((await promptOf(db, "beam-checker")).version).toBe(1);
});
