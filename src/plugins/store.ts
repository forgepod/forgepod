import type { Kysely } from "kysely";
import type { Schema } from "../db/schema";
import type { Inspection } from "./registry";

export type StoredTool = {
  name: string;
  description: string | null;
  inputSchema: unknown;
  outputSchema: unknown;
};

export type StoredPlugin = {
  name: string;
  version: string;
  description: string | null;
  transport: string;
  launch: string;
  sourceDir: string;
  scannedAt: string;
  roundTripMs: number | null;
  error: string | null;
  tools: StoredTool[];
};

/**
 * The filesystem is the source of truth for what is installed, so a scan replaces the
 * stored picture rather than merging into it. A plugin deleted from disk disappears
 * here on the next scan, which is the behaviour an operator expects.
 */
export async function saveScan(
  db: Kysely<Schema>,
  results: Inspection[],
  scannedAt: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("plugin_tools").execute();
    await trx.deleteFrom("plugins").execute();

    for (const result of results) {
      const manifest = result.manifest;
      if (!manifest) continue;

      await trx
        .insertInto("plugins")
        .values({
          name: manifest.name,
          version: manifest.version,
          description: manifest.description ?? null,
          transport: manifest.transport,
          launch: result.launch ?? "",
          manifest: JSON.stringify(manifest),
          source_dir: result.dir,
          scanned_at: scannedAt,
          round_trip_ms: result.ms ?? null,
          error: result.error ?? null,
        })
        .execute();

      for (const tool of result.tools ?? []) {
        await trx
          .insertInto("plugin_tools")
          .values({
            plugin_name: manifest.name,
            name: tool.name,
            description: tool.description ?? null,
            input_schema: JSON.stringify(tool.inputSchema),
            output_schema: tool.outputSchema ? JSON.stringify(tool.outputSchema) : null,
          })
          .execute();
      }
    }
  });
}

export async function loadPlugins(db: Kysely<Schema>): Promise<StoredPlugin[]> {
  const plugins = await db.selectFrom("plugins").selectAll().orderBy("name").execute();
  const tools = await db
    .selectFrom("plugin_tools")
    .selectAll()
    .orderBy("plugin_name")
    .orderBy("name")
    .execute();

  return plugins.map((row) => ({
    name: row.name,
    version: row.version,
    description: row.description,
    transport: row.transport,
    launch: row.launch,
    sourceDir: row.source_dir,
    scannedAt: row.scanned_at,
    roundTripMs: row.round_trip_ms,
    error: row.error,
    tools: tools
      .filter((t) => t.plugin_name === row.name)
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: JSON.parse(t.input_schema),
        outputSchema: t.output_schema ? JSON.parse(t.output_schema) : undefined,
      })),
  }));
}
