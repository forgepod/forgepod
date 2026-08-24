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

export type Schema = {
  plugins: PluginRow;
  plugin_tools: PluginToolRow;
  agents: AgentRow;
  agent_versions: AgentVersionRow;
  agent_tools: AgentToolRow;
  runs: RunRow;
  run_steps: RunStepRow;
  run_usage: RunUsageRow;
};
