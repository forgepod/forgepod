import type { Kysely, Transaction } from "kysely";
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

/**
 * A connection or an open transaction. Taking this rather than a connection is what lets
 * one caller write several agents atomically: Kysely refuses a transaction inside a
 * transaction, so a function that opens its own can never be composed.
 */
export type Executor = Kysely<Schema> | Transaction<Schema>;

/**
 * A binding is kept by name and survives a rescan on purpose, so a plugin that is briefly
 * down does not erase an agent's configuration. The cost is that a binding can outlive the
 * tool it names, after a plugin is upgraded or removed. `available` is that difference,
 * computed against the same rows the run resolves against, so what the page shows and what
 * the run can call are one answer rather than two.
 */
export type BoundTool = BoundToolRef & { available: boolean };

export type AgentDetail = {
  id: string;
  slug: string;
  name: string;
  versionId: string;
  version: number;
  model: string;
  systemPrompt: string;
  tools: BoundTool[];
};

/**
 * What an agent gets when neither the template nor the operator named a model. Read at
 * call time rather than frozen at import, because the install that sets it is the same
 * one that chooses a provider: an install pointed at a gateway has no Anthropic model
 * ids, and every agent it creates would otherwise be born on one it cannot call.
 *
 * That case refuses to guess. An install with a base URL set is talking to a gateway
 * whose model ids are its own, so the built-in default is wrong there by construction,
 * and falling through would create an agent that only fails later, on its first run,
 * with the gateway's wording rather than the variable name that fixes it.
 */
export function defaultModel(env: Record<string, string | undefined> = process.env): string {
  const named = env.FORGEPOD_DEFAULT_MODEL?.trim();
  if (named) return named;

  if (env.FORGEPOD_BASE_URL?.trim()) {
    throw new Error(
      "FORGEPOD_BASE_URL is set, so FORGEPOD_DEFAULT_MODEL has to be set as well: " +
        "the built-in default is an Anthropic model id, and a gateway serves its own.",
    );
  }

  return "claude-opus-5";
}

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

  // The same join `runnableTools` resolves through, so the two cannot disagree.
  const published = await db
    .selectFrom("plugin_tools")
    .innerJoin("plugins", "plugins.name", "plugin_tools.plugin_name")
    .select(["plugin_tools.plugin_name", "plugin_tools.name"])
    .execute();

  const resolvable = new Set(published.map((t) => `${t.plugin_name} ${t.name}`));

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    versionId: row.version_id,
    version: row.version,
    model: row.model,
    systemPrompt: row.system_prompt,
    tools: tools.map((t) => ({
      pluginName: t.plugin_name,
      toolName: t.tool_name,
      available: resolvable.has(`${t.plugin_name} ${t.tool_name}`),
    })),
  };
}

export async function createAgent(
  db: Kysely<Schema>,
  input: { name: string; model?: string; systemPrompt?: string },
  now = new Date().toISOString(),
): Promise<string> {
  const agentId = crypto.randomUUID();

  // One transaction for both, so a process that dies between them cannot leave an agent
  // with no version, which `listAgents` would inner join into an invisible row.
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("agents")
      .values({
        id: agentId,
        slug: slugify(input.name),
        name: input.name,
        created_at: now,
        published_version_id: null,
        owner_id: null,
      })
      .execute();

    await publishVersion(
      trx,
      agentId,
      {
        model: input.model ?? defaultModel(),
        systemPrompt: input.systemPrompt ?? "",
        tools: [],
      },
      now,
    );
  });

  return agentId;
}

/**
 * Saving is publishing a new version. History comes for free that way, and no run ever
 * has its recorded configuration edited out from under it.
 *
 * Runs on whatever executor it is given and opens no transaction of its own, so the
 * caller decides what is atomic with what.
 */
export async function publishVersion(
  exec: Executor,
  agentId: string,
  input: { model: string; systemPrompt: string; tools: BoundToolRef[] },
  now = new Date().toISOString(),
): Promise<string> {
  const versionId = crypto.randomUUID();

  const previous = await exec
    .selectFrom("agent_versions")
    .select("version")
    .where("agent_id", "=", agentId)
    .orderBy("version", "desc")
    .executeTakeFirst();

  await exec
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
    await exec
      .insertInto("agent_tools")
      .values({
        agent_version_id: versionId,
        plugin_name: tool.pluginName,
        tool_name: tool.toolName,
      })
      .execute();
  }

  await exec
    .updateTable("agents")
    .set({ published_version_id: versionId })
    .where("id", "=", agentId)
    .execute();

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

/**
 * Runs reference a version, so they go before it. The version and its bindings then go
 * with the agent by cascade. Deleting an agent deletes its history: a run whose
 * configuration no longer exists could not be read back honestly anyway.
 */
export async function deleteAgent(db: Kysely<Schema>, agentId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const versions = await trx
      .selectFrom("agent_versions")
      .select("id")
      .where("agent_id", "=", agentId)
      .execute();

    const ids = versions.map((v) => v.id);
    if (ids.length > 0) {
      await trx.deleteFrom("runs").where("agent_version_id", "in", ids).execute();
    }

    await trx.updateTable("agents").set({ published_version_id: null }).where("id", "=", agentId).execute();
    await trx.deleteFrom("agents").where("id", "=", agentId).execute();
  });
}
