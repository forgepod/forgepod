import type { Kysely } from "kysely";
import type { Schema } from "./schema";

// Creates what is missing and nothing else, so it cannot alter an existing column.
// Replace with versioned migrations before the schema holds anyone else's data.
export async function migrate(db: Kysely<Schema>): Promise<void> {
  await db.schema
    .createTable("plugins")
    .ifNotExists()
    .addColumn("name", "text", (c) => c.primaryKey())
    .addColumn("version", "text", (c) => c.notNull())
    .addColumn("description", "text")
    .addColumn("transport", "text", (c) => c.notNull())
    .addColumn("launch", "text", (c) => c.notNull())
    .addColumn("manifest", "text", (c) => c.notNull())
    .addColumn("source_dir", "text", (c) => c.notNull())
    .addColumn("scanned_at", "text", (c) => c.notNull())
    .addColumn("round_trip_ms", "integer")
    .addColumn("error", "text")
    .execute();

  await db.schema
    .createTable("plugin_tools")
    .ifNotExists()
    .addColumn("plugin_name", "text", (c) => c.notNull().references("plugins.name").onDelete("cascade"))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("description", "text")
    .addColumn("input_schema", "text", (c) => c.notNull())
    .addColumn("output_schema", "text")
    .addPrimaryKeyConstraint("plugin_tools_pk", ["plugin_name", "name"])
    .execute();

  await db.schema
    .createTable("agents")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("slug", "text", (c) => c.notNull().unique())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("published_version_id", "text")
    .execute();

  await db.schema
    .createTable("agent_versions")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("agent_id", "text", (c) => c.notNull().references("agents.id").onDelete("cascade"))
    .addColumn("version", "integer", (c) => c.notNull())
    .addColumn("model", "text", (c) => c.notNull())
    .addColumn("system_prompt", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("agent_tools")
    .ifNotExists()
    .addColumn("agent_version_id", "text", (c) =>
      c.notNull().references("agent_versions.id").onDelete("cascade"),
    )
    .addColumn("plugin_name", "text", (c) => c.notNull())
    .addColumn("tool_name", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("agent_tools_pk", ["agent_version_id", "plugin_name", "tool_name"])
    .execute();

  // Runs point at a version, never at an agent, so publishing a change never rewrites
  // the history of what an earlier run actually executed.
  await db.schema
    .createTable("runs")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("agent_version_id", "text", (c) => c.notNull().references("agent_versions.id"))
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("input", "text", (c) => c.notNull())
    .addColumn("started_at", "text", (c) => c.notNull())
    .addColumn("ended_at", "text")
    .addColumn("error", "text")
    .execute();

  await db.schema
    .createTable("run_steps")
    .ifNotExists()
    .addColumn("run_id", "text", (c) => c.notNull().references("runs.id").onDelete("cascade"))
    .addColumn("seq", "integer", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("payload", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("run_steps_pk", ["run_id", "seq"])
    .execute();

  await db.schema
    .createTable("run_usage")
    .ifNotExists()
    .addColumn("run_id", "text", (c) => c.notNull().references("runs.id").onDelete("cascade"))
    .addColumn("seq", "integer", (c) => c.notNull())
    .addColumn("provider", "text", (c) => c.notNull())
    .addColumn("model", "text", (c) => c.notNull())
    .addColumn("input_tokens", "integer", (c) => c.notNull())
    .addColumn("output_tokens", "integer", (c) => c.notNull())
    .addPrimaryKeyConstraint("run_usage_pk", ["run_id", "seq"])
    .execute();
}
