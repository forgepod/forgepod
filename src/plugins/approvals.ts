import type { Kysely } from "kysely";
import { installId } from "../db/install";
import type { Schema } from "../db/schema";
import { connect, PluginManifest, resultValue } from "./mcp";

/**
 * A plugin that publishes both of these is asking to be answered from the admin, so core
 * never learns a plugin's name to find one. Anything else it publishes stays reachable
 * only from inside a run, which is where a tool call belongs.
 */
const PAIR = ["list_pending", "resolve"] as const;

export type Pending = {
  plugin: string;
  id: number;
  agent: string;
  tool: string;
  input: unknown;
  runId: string | null;
  requestedAt: string;
};

/**
 * The one route from the admin to a plugin's tool. It opens a connection for the single
 * call and closes it: nothing here is on a run's hot path, and a page that leaves plugin
 * processes running is worse than a page that is slow.
 */
async function callTool(
  db: Kysely<Schema>,
  plugin: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const row = await db
    .selectFrom("plugins")
    .select(["manifest", "source_dir"])
    .where("name", "=", plugin)
    .executeTakeFirst();
  if (!row) throw new Error(`${plugin} is not installed`);

  const client = await connect(PluginManifest.parse(JSON.parse(row.manifest)), {
    cwd: row.source_dir,
    // No agent and no run: this call is the operator's, not an agent's, and a plugin
    // that scopes its state by agent must not read this as one.
    identity: { FORGEPOD_INSTALL_ID: await installId(db) },
  });
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    if (result.isError === true) throw new Error(String(resultValue(result)));
    return resultValue(result);
  } finally {
    await client.close();
  }
}

/** Every scanned plugin that publishes the pair. Usually one, and often none. */
export async function approvalPlugins(db: Kysely<Schema>): Promise<string[]> {
  const rows = await db
    .selectFrom("plugin_tools")
    .select("plugin_name")
    .where("name", "in", [...PAIR])
    .groupBy("plugin_name")
    .having((eb) => eb.fn.count("name"), "=", PAIR.length)
    .orderBy("plugin_name")
    .execute();
  return rows.map((row) => row.plugin_name);
}

/**
 * What is waiting on a human, for one run. Launching a plugin per page load is the cost
 * of the plugin owning its own state, and it is paid only where a card can appear.
 */
export async function pendingApprovals(db: Kysely<Schema>, runId: string): Promise<Pending[]> {
  const found: Pending[] = [];

  for (const plugin of await approvalPlugins(db)) {
    // A plugin that cannot answer is not a reason the agent page fails to render.
    const answered = await callTool(db, plugin, "list_pending", {}).catch(() => null);
    const rows = (answered as { pending?: unknown })?.pending;
    if (!Array.isArray(rows)) continue;

    for (const row of rows as Record<string, unknown>[]) {
      if (row.runId !== runId) continue;
      found.push({
        plugin,
        id: Number(row.id),
        agent: String(row.agent ?? ""),
        tool: String(row.tool ?? ""),
        input: row.input,
        runId: row.runId as string,
        requestedAt: String(row.requestedAt ?? ""),
      });
    }
  }

  return found;
}

export const resolveApproval = async (
  db: Kysely<Schema>,
  plugin: string,
  id: number,
  decision: string,
): Promise<void> => {
  await callTool(db, plugin, "resolve", { id, decision });
};
