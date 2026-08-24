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

export type Schema = {
  plugins: PluginRow;
  plugin_tools: PluginToolRow;
};
