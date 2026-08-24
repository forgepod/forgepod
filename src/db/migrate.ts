import type { Kysely } from "kysely";
import type { Schema } from "./schema";

// ponytail: creates what is missing and nothing else, so it cannot alter an existing
// column. Replace with versioned migrations before the schema has anyone else's data
// in it.
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
}
