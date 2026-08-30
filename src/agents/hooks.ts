import type { Kysely } from "kysely";
import { z } from "zod";
import type { Schema } from "../db/schema";

/**
 * The five points a run can be extended at. An action is told what happened and cannot
 * change it. A filter is asked, and its answer decides what runs next.
 *
 * The list is deliberately short. Every point here is a promise to keep working the same
 * way for anyone who binds to it, so a sixth one is a decision rather than a detail.
 */
export const ACTION_HOOKS = ["run.before", "run.after", "run.error", "tool.after_call"] as const;
export const FILTER_HOOKS = ["tool.before_call", "run.before_provider_call"] as const;
export const HOOKS = [...ACTION_HOOKS, ...FILTER_HOOKS] as const;

export type HookName = (typeof HOOKS)[number];

export const isFilterHook = (hook: string): hook is (typeof FILTER_HOOKS)[number] =>
  (FILTER_HOOKS as readonly string[]).includes(hook);

export type HookBinding = { hook: HookName; pluginName: string; toolName: string };

/**
 * How a handler is actually reached. It is a callback so this file never learns MCP, and
 * so a test can exercise the ordering and the failure rules without launching anything.
 * It throws when the handler failed, which is the only signal the rules below need.
 */
export type Invoke = (binding: HookBinding, payload: Record<string, unknown>) => Promise<unknown>;

/** What a run was given at its start. Read many times per run, so it is read once. */
export type Bindings = (hook: HookName) => HookBinding[];

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A filter sits in front of every tool call an agent makes, so a plugin bound there can
 * read and rewrite the work of every other plugin. That is a decision for whoever runs
 * the install, never for the plugin, so nothing here is derived from the manifest.
 */
const trustKey = (plugin: string) => `plugin_trust:${plugin}`;

export async function isTrusted(db: Kysely<Schema>, plugin: string): Promise<boolean> {
  const row = await db
    .selectFrom("settings")
    .select("value")
    .where("key", "=", trustKey(plugin))
    .executeTakeFirst();
  return row?.value === "trusted";
}

/**
 * ponytail: trust is one settings row per plugin rather than a column on `plugins`,
 * because a scan replaces every plugin row and trust has to outlive a plugin that is
 * briefly missing from disk. Promote it to its own table when who granted it and when
 * has to be recorded too.
 */
export async function trustPlugin(
  db: Kysely<Schema>,
  plugin: string,
  trusted = true,
): Promise<void> {
  if (!trusted) {
    await db.deleteFrom("settings").where("key", "=", trustKey(plugin)).execute();
    return;
  }
  await db
    .insertInto("settings")
    .values({ key: trustKey(plugin), value: "trusted" })
    .onConflict((c) => c.column("key").doUpdateSet({ value: "trusted" }))
    .execute();
}

export async function assertCanBind(
  db: Kysely<Schema>,
  plugin: string,
  hook: HookName,
): Promise<void> {
  if (!isFilterHook(hook)) return;
  if (await isTrusted(db, plugin)) return;
  throw new Error(
    `${plugin} has to be trusted before it can bind to ${hook}: a filter there decides ` +
      `whether every other plugin's call runs at all.`,
  );
}

/** The one door into `hook_bindings`, so no caller can bind past the trust check. */
export async function bindHook(
  db: Kysely<Schema>,
  binding: {
    /** Null binds every agent in the install. */
    agentId: string | null;
    hook: HookName;
    pluginName: string;
    toolName: string;
    priority?: number;
  },
  now = new Date().toISOString(),
): Promise<string> {
  if (!(HOOKS as readonly string[]).includes(binding.hook)) {
    throw new Error(`no such hook: ${binding.hook}. One of ${HOOKS.join(", ")}`);
  }
  await assertCanBind(db, binding.pluginName, binding.hook);

  const id = crypto.randomUUID();
  await db
    .insertInto("hook_bindings")
    .values({
      id,
      agent_id: binding.agentId,
      hook_name: binding.hook,
      plugin_name: binding.pluginName,
      tool_name: binding.toolName,
      priority: binding.priority ?? 10,
      created_at: now,
    })
    .execute();
  return id;
}

export const unbindHook = async (db: Kysely<Schema>, id: string): Promise<void> => {
  await db.deleteFrom("hook_bindings").where("id", "=", id).execute();
};

export type StoredBinding = HookBinding & {
  id: string;
  agentId: string | null;
  priority: number;
};

/** Everything bound to this agent, plus everything bound install-wide. */
export async function listBindings(
  db: Kysely<Schema>,
  agentId: string | null,
): Promise<StoredBinding[]> {
  let query = db.selectFrom("hook_bindings").selectAll();
  query = agentId
    ? query.where((eb) => eb.or([eb("agent_id", "=", agentId), eb("agent_id", "is", null)]))
    : query.where("agent_id", "is", null);

  const rows = await query.orderBy("priority").orderBy("created_at").execute();
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    hook: row.hook_name as HookName,
    pluginName: row.plugin_name,
    toolName: row.tool_name,
    priority: row.priority,
  }));
}

export async function loadBindings(db: Kysely<Schema>, agentId: string): Promise<Bindings> {
  const stored = await listBindings(db, agentId);
  const byHook = new Map<string, HookBinding[]>();
  for (const row of stored) {
    const list = byHook.get(row.hook) ?? [];
    list.push({ hook: row.hook, pluginName: row.pluginName, toolName: row.toolName });
    byHook.set(row.hook, list);
  }
  return (hook) => byHook.get(hook) ?? [];
}

/**
 * Fail open. An audit log that is down must not take the run with it, so a handler that
 * throws is reported and the run continues. That is the whole reason actions and filters
 * are separate lists rather than one with a flag.
 */
export async function fireAction(
  bindings: Bindings,
  hook: (typeof ACTION_HOOKS)[number],
  payload: Record<string, unknown>,
  invoke: Invoke,
  onWarn: (text: string) => void | Promise<void> = () => undefined,
): Promise<void> {
  for (const binding of bindings(hook)) {
    try {
      await invoke(binding, { hook, ...payload });
    } catch (e) {
      await onWarn(
        `hook ${hook}: ${binding.pluginName}.${binding.toolName} failed: ${describe(e)}`,
      );
    }
  }
}

const Verdict = z.object({
  action: z.enum(["allow", "block", "modify"]),
  /** Only read when the action is modify. Whatever it is replaces the filtered value. */
  value: z.unknown().optional(),
  reason: z.string().nullish(),
});

export type FilterOutcome = { blocked: string } | { value: unknown };

/**
 * Fail closed, the mirror of an action. A guardrail that cannot answer has not allowed
 * anything, so a handler that throws, or answers in a shape this cannot read, blocks.
 *
 * Handlers run in priority order and each one sees what the previous returned, so a
 * redaction filter and an approval filter compose without knowing about each other.
 */
export async function applyFilter(args: {
  bindings: Bindings;
  hook: (typeof FILTER_HOOKS)[number];
  /** The one thing this hook lets a handler rewrite: a tool's input, or a system prompt. */
  value: unknown;
  /** Rebuilt per handler, because the value it is asked about is the previous answer. */
  payloadFor: (value: unknown) => Record<string, unknown>;
  invoke: Invoke;
}): Promise<FilterOutcome> {
  let value = args.value;

  for (const binding of args.bindings(args.hook)) {
    const named = `${binding.pluginName}.${binding.toolName}`;
    let verdict: z.infer<typeof Verdict>;

    try {
      verdict = Verdict.parse(await args.invoke(binding, { hook: args.hook, ...args.payloadFor(value) }));
    } catch (e) {
      return { blocked: `hook ${args.hook}: ${named} did not answer: ${describe(e)}` };
    }

    if (verdict.action === "block") {
      return { blocked: verdict.reason ?? `blocked by ${named}` };
    }
    if (verdict.action === "modify") {
      if (verdict.value === undefined) {
        return { blocked: `hook ${args.hook}: ${named} asked to modify without a value` };
      }
      value = verdict.value;
    }
  }

  return { value };
}
