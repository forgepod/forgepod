import { readdir } from "node:fs/promises";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { connect, loadManifest, resolveLaunch, type PluginManifest } from "./mcp";

/** A directory holding a plugin.json is an installed plugin. */
export const pluginRoot = () => process.env.FORGEPOD_PLUGIN_DIR || "plugins";

export type Installed = { dir: string; manifest?: PluginManifest; error?: string };
export type Inspection = Installed & { launch?: string; tools?: Tool[]; ms?: number };

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function installedPlugins(root = pluginRoot()): Promise<Installed[]> {
  let names: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const found = await Promise.all(
    names.map(async (name): Promise<Installed | null> => {
      const dir = `${root}/${name}`;
      try {
        return { dir, manifest: await loadManifest(dir) };
      } catch (e) {
        // A directory with no manifest is not a plugin. A directory with a broken
        // one is, and hiding it is how an operator loses an hour.
        if (describe(e).includes("ENOENT")) return null;
        return { dir, error: describe(e) };
      }
    }),
  );

  return found.filter((x) => x !== null).sort((a, b) => a.dir.localeCompare(b.dir));
}

export function launchLine(manifest: PluginManifest): string {
  if (manifest.transport === "http") return manifest.url;
  const { command, args } = resolveLaunch(manifest);
  return [command, ...args].join(" ");
}

// Starts the plugin and waits for it to answer, so this is slow and side effecting.
// Callers run it when an operator asks for a scan, never on a page load: what a page
// renders is the stored result of the last one.
export async function inspect(entry: Installed): Promise<Inspection> {
  if (!entry.manifest) return entry;
  const launch = launchLine(entry.manifest);
  const started = performance.now();

  try {
    const client = await connect(entry.manifest, { cwd: entry.dir });
    try {
      const { tools } = await client.listTools();
      return { ...entry, launch, tools, ms: Math.round(performance.now() - started) };
    } finally {
      await client.close();
    }
  } catch (e) {
    return { ...entry, launch, error: describe(e) };
  }
}
