/**
 * Every column is text or integer, and every timestamp is an ISO 8601 string. That is
 * the whole reason one schema serves both SQLite and Postgres: nothing here asks for a
 * type only one of them has. Manifests and JSON Schemas are stored verbatim as text
 * rather than as jsonb, which would tie the schema to Postgres.
 */
export type PluginRow = {
  name: string;
  version: string;
  description: string | null;
  transport: string;
  launch: string;
  manifest: string;
  source_dir: string;
  scanned_at: string;
  round_trip_ms: number | null;
  error: string | null;
};

export type PluginToolRow = {
  plugin_name: string;
  name: string;
  description: string | null;
  input_schema: string;
  output_schema: string | null;
};

export type AgentRow = {
  id: string;
  slug: string;
  name: string;
  created_at: string;
  published_version_id: string | null;
};

export type AgentVersionRow = {
  id: string;
  agent_id: string;
  version: number;
  model: string;
  system_prompt: string;
  created_at: string;
};

/** A binding is to a version, so editing an agent never rewrites what an old run ran. */
export type AgentToolRow = {
  agent_version_id: string;
  plugin_name: string;
  tool_name: string;
};

export type RunRow = {
  id: string;
  agent_version_id: string;
  status: string;
  input: string;
  started_at: string;
  ended_at: string | null;
  error: string | null;
};

export type RunStepRow = {
  run_id: string;
  seq: number;
  kind: string;
  payload: string;
};

/** Only core sees a run, so only core can count it. What it costs is a plugin's job. */
export type RunUsageRow = {
  run_id: string;
  seq: number;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
};

/**
 * One row = one plugin tool called at one point in a run. A hook is not a second way to
 * write a plugin: the handler is an ordinary MCP tool, and this table only records when
 * core should call it.
 *
 * The binding is to an agent, not to an agent version, because a hook is operator
 * configuration rather than part of what the agent says. Binding it to a version would
 * drop a guardrail the moment someone edits a prompt and publishes. A null agent_id
 * binds every agent in the install.
 *
 * Whether a hook is an action or a filter follows from its name, so it is not stored.
 */
export type HookBindingRow = {
  id: string;
  agent_id: string | null;
  hook_name: string;
  plugin_name: string;
  tool_name: string;
  /** Lower runs first, the usual convention. Ties break on created_at. */
  priority: number;
  created_at: string;
};

/** One row per install-wide fact. Keyed by name so adding one needs no migration. */
export type SettingRow = {
  key: string;
  value: string;
};

/**
 * One row per agent a template created, which is the grain an upgrade actually needs.
 * `source_hash` is what the template wrote, so an agent whose current content still
 * hashes to it has not been touched and can be moved to a newer version safely. An
 * operator's edit changes the hash, and that is the whole stopping rule.
 */
export type TemplateInstallRow = {
  template_name: string;
  agent_id: string;
  installed_version: string;
  source_hash: string;
  installed_at: string;
};

export type Schema = {
  settings: SettingRow;
  plugins: PluginRow;
  plugin_tools: PluginToolRow;
  agents: AgentRow;
  agent_versions: AgentVersionRow;
  agent_tools: AgentToolRow;
  runs: RunRow;
  run_steps: RunStepRow;
  run_usage: RunUsageRow;
  hook_bindings: HookBindingRow;
  template_installs: TemplateInstallRow;
};
