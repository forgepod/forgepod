import type { Kysely } from "kysely";
import type { Schema } from "../db/schema";
import type { RunStep } from "./run";

export type AgentSummary = {
  id: string;
  slug: string;
  name: string;
  model: string;
  version: number;
  toolCount: number;
};

export type BoundToolRef = { pluginName: string; toolName: string };

export type AgentDetail = {
  id: string;
  slug: string;
  name: string;
  versionId: string;
  version: number;
  model: string;
  systemPrompt: string;
  tools: BoundToolRef[];
};

export const DEFAULT_MODEL = "claude-opus-5";

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "agent";

export async function listAgents(db: Kysely<Schema>): Promise<AgentSummary[]> {
  const rows = await db
    .selectFrom("agents")
    .innerJoin("agent_versions", "agent_versions.id", "agents.published_version_id")
    .select([
      "agents.id",
      "agents.slug",
      "agents.name",
      "agent_versions.id as version_id",
      "agent_versions.model",
      "agent_versions.version",
    ])
    .orderBy("agents.name")
    .execute();

  const bindings = await db.selectFrom("agent_tools").select("agent_version_id").execute();

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    model: row.model,
    version: row.version,
    toolCount: bindings.filter((b) => b.agent_version_id === row.version_id).length,
  }));
}

export async function loadAgent(db: Kysely<Schema>, id: string): Promise<AgentDetail | null> {
  const row = await db
    .selectFrom("agents")
    .innerJoin("agent_versions", "agent_versions.id", "agents.published_version_id")
    .select([
      "agents.id",
      "agents.slug",
      "agents.name",
      "agent_versions.id as version_id",
      "agent_versions.version",
      "agent_versions.model",
      "agent_versions.system_prompt",
    ])
    .where("agents.id", "=", id)
    .executeTakeFirst();

  if (!row) return null;

  const tools = await db
    .selectFrom("agent_tools")
    .select(["plugin_name", "tool_name"])
    .where("agent_version_id", "=", row.version_id)
    .orderBy("plugin_name")
    .orderBy("tool_name")
    .execute();

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    versionId: row.version_id,
    version: row.version,
    model: row.model,
    systemPrompt: row.system_prompt,
    tools: tools.map((t) => ({ pluginName: t.plugin_name, toolName: t.tool_name })),
  };
}

export async function createAgent(
  db: Kysely<Schema>,
  input: { name: string; model?: string; systemPrompt?: string },
  now = new Date().toISOString(),
): Promise<string> {
  const agentId = crypto.randomUUID();

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("agents")
      .values({
        id: agentId,
        slug: slugify(input.name),
        name: input.name,
        created_at: now,
        published_version_id: null,
      })
      .execute();
  });

  await publishVersion(db, agentId, {
    model: input.model ?? DEFAULT_MODEL,
    systemPrompt: input.systemPrompt ?? "",
    tools: [],
  }, now);

  return agentId;
}

/**
 * Saving is publishing a new version. History comes for free that way, and no run ever
 * has its recorded configuration edited out from under it.
 */
export async function publishVersion(
  db: Kysely<Schema>,
  agentId: string,
  input: { model: string; systemPrompt: string; tools: BoundToolRef[] },
  now = new Date().toISOString(),
): Promise<string> {
  const versionId = crypto.randomUUID();

  await db.transaction().execute(async (trx) => {
    const previous = await trx
      .selectFrom("agent_versions")
      .select("version")
      .where("agent_id", "=", agentId)
      .orderBy("version", "desc")
      .executeTakeFirst();

    await trx
      .insertInto("agent_versions")
      .values({
        id: versionId,
        agent_id: agentId,
        version: (previous?.version ?? 0) + 1,
        model: input.model,
        system_prompt: input.systemPrompt,
        created_at: now,
      })
      .execute();

    for (const tool of input.tools) {
      await trx
        .insertInto("agent_tools")
        .values({
          agent_version_id: versionId,
          plugin_name: tool.pluginName,
          tool_name: tool.toolName,
        })
        .execute();
    }

    await trx
      .updateTable("agents")
      .set({ published_version_id: versionId })
      .where("id", "=", agentId)
      .execute();
  });

  return versionId;
}

export type RunRecord = {
  id: string;
  status: string;
  input: string;
  startedAt: string;
  error: string | null;
  steps: RunStep[];
  inputTokens: number;
  outputTokens: number;
};

export async function latestRun(db: Kysely<Schema>, agentId: string): Promise<RunRecord | null> {
  const run = await db
    .selectFrom("runs")
    .innerJoin("agent_versions", "agent_versions.id", "runs.agent_version_id")
    .select(["runs.id", "runs.status", "runs.input", "runs.started_at", "runs.error"])
    .where("agent_versions.agent_id", "=", agentId)
    .orderBy("runs.started_at", "desc")
    .limit(1)
    .executeTakeFirst();

  if (!run) return null;

  const steps = await db
    .selectFrom("run_steps")
    .select("payload")
    .where("run_id", "=", run.id)
    .orderBy("seq")
    .execute();

  const usage = await db
    .selectFrom("run_usage")
    .select(["input_tokens", "output_tokens"])
    .where("run_id", "=", run.id)
    .execute();

  return {
    id: run.id,
    status: run.status,
    input: run.input,
    startedAt: run.started_at,
    error: run.error,
    steps: steps.map((s) => JSON.parse(s.payload) as RunStep),
    inputTokens: usage.reduce((n, u) => n + u.input_tokens, 0),
    outputTokens: usage.reduce((n, u) => n + u.output_tokens, 0),
  };
}
