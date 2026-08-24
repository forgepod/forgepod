import type { Kysely } from "kysely";
import { defaultModel, publishVersion } from "../agents/store";
import type { Schema } from "../db/schema";
import { composePrompt, type TemplateManifest } from "./manifest";

export type Problem =
  | { kind: "missing-plugin"; plugin: string }
  | { kind: "unknown-tool"; plugin: string; tool: string }
  | { kind: "slug-taken"; slug: string };

export function describeProblem(problem: Problem): string {
  switch (problem.kind) {
    case "missing-plugin":
      return `plugin not installed or not scanned: ${problem.plugin}`;
    case "unknown-tool":
      return `no plugin publishes this tool: ${problem.plugin}.${problem.tool}`;
    case "slug-taken":
      return `an agent already uses this slug: ${problem.slug}`;
  }
}

/** Separates a plugin name from a tool name without colliding with either. */
const toolKey = (plugin: string, tool: string) => `${plugin} ${tool}`;

/**
 * Every reason this template cannot install, not the first one. An operator missing two
 * plugins should learn that once rather than once per attempt, and the admin page renders
 * the same list before the button is pressed.
 */
export async function checkTemplate(
  db: Kysely<Schema>,
  manifest: TemplateManifest,
): Promise<Problem[]> {
  const problems: Problem[] = [];

  // The plugins table is the last scan, so a plugin sitting on disk that was never
  // scanned counts as missing. That is correct: it has no tool list to bind to.
  const plugins = new Set(
    (await db.selectFrom("plugins").select("name").execute()).map((r) => r.name),
  );

  // A plugin a tool is bound to counts as required whether the author listed it or not,
  // so forgetting it in `requires` is reported as the missing plugin it is.
  const wanted = new Set([
    ...manifest.requires,
    ...manifest.agents.flatMap((a) => a.tools.map((t) => t.plugin)),
  ]);
  const missing = new Set([...wanted].filter((name) => !plugins.has(name)));
  for (const plugin of missing) problems.push({ kind: "missing-plugin", plugin });

  const tools = new Set(
    (await db.selectFrom("plugin_tools").select(["plugin_name", "name"]).execute()).map((r) =>
      toolKey(r.plugin_name, r.name),
    ),
  );
  const taken = new Set(
    (await db.selectFrom("agents").select("slug").execute()).map((r) => r.slug),
  );

  for (const agent of manifest.agents) {
    for (const ref of agent.tools) {
      // A tool of an absent plugin is not an unknown tool, it is the absent plugin again.
      // Saying both turns one missing plugin into a page of complaints.
      if (missing.has(ref.plugin)) continue;
      if (!tools.has(toolKey(ref.plugin, ref.tool))) {
        problems.push({ kind: "unknown-tool", plugin: ref.plugin, tool: ref.tool });
      }
    }
    if (taken.has(agent.slug)) problems.push({ kind: "slug-taken", slug: agent.slug });
  }

  return problems;
}

/**
 * A one-way seed. Nothing records that a template was involved, so what an operator has
 * afterwards are ordinary agents. Validation runs to completion before the first write and
 * the writes share one transaction, so a template installs whole or not at all.
 */
export async function installTemplate(
  db: Kysely<Schema>,
  manifest: TemplateManifest,
  now = new Date().toISOString(),
): Promise<string[]> {
  const problems = await checkTemplate(db, manifest);
  if (problems.length > 0) {
    throw new Error(
      [`${manifest.name} cannot be installed:`, ...problems.map(describeProblem)].join("\n"),
    );
  }

  const ids = manifest.agents.map(() => crypto.randomUUID());

  await db.transaction().execute(async (trx) => {
    for (const [index, agent] of manifest.agents.entries()) {
      const id = ids[index]!;

      await trx
        .insertInto("agents")
        .values({
          id,
          slug: agent.slug,
          name: agent.name,
          created_at: now,
          published_version_id: null,
        })
        .execute();

      await publishVersion(
        trx,
        id,
        {
          model: agent.model ?? defaultModel(),
          systemPrompt: composePrompt(agent),
          tools: agent.tools.map((t) => ({ pluginName: t.plugin, toolName: t.tool })),
        },
        now,
      );
    }
  });

  return ids;
}
