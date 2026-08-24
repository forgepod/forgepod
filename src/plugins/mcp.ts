import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

const base = {
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
};

export const PluginManifest = z.discriminatedUnion("transport", [
  z.object({
    ...base,
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    // Present means the plugin ships as an image. Absent means it runs on the host,
    // which is only for developing a plugin.
    image: z.string().optional(),
  }),
  z.object({
    ...base,
    transport: z.literal("http"),
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

export type PluginManifest = z.infer<typeof PluginManifest>;
type StdioManifest = Extract<PluginManifest, { transport: "stdio" }>;

export async function loadManifest(dir: string): Promise<PluginManifest> {
  return PluginManifest.parse(await Bun.file(`${dir}/plugin.json`).json());
}

/**
 * Containerising a plugin is this rewrite and nothing else. Core holds no Docker
 * client, no image build logic and no port allocation, because stdio means the
 * container's own stdin and stdout are the channel.
 */
export function resolveLaunch(
  manifest: StdioManifest,
  useContainer = Boolean(manifest.image),
): { command: string; args: string[] } {
  if (!useContainer) return { command: manifest.command, args: manifest.args };
  if (!manifest.image) throw new Error(`plugin ${manifest.name} has no image to run`);

  const env = Object.keys(manifest.env ?? {}).flatMap((key) => ["-e", key]);
  return { command: "docker", args: ["run", "--rm", "-i", ...env, manifest.image] };
}

export async function connect(
  manifest: PluginManifest,
  opts: { cwd?: string; useContainer?: boolean } = {},
): Promise<Client> {
  const client = new Client({ name: "forgepod", version: "0.1.0" });

  if (manifest.transport === "http") {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(manifest.url), {
        requestInit: { headers: manifest.headers },
      }),
    );
    return client;
  }

  await client.connect(
    new StdioClientTransport({
      ...resolveLaunch(manifest, opts.useContainer),
      cwd: opts.cwd,
      // Merged, not replaced: the transport's default environment is a filtered
      // allowlist, and dropping it breaks anything that needs PATH or HOME.
      env: { ...getDefaultEnvironment(), ...manifest.env },
      stderr: "pipe",
    }),
  );
  return client;
}
