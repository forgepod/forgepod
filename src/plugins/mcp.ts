import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
    // A container is started with `--rm` and a run closes it at the end, so a plugin that
    // declares nothing here keeps nothing. Declaring it gets a directory that survives.
    state: z.boolean().optional(),
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
  return PluginManifest.parse(JSON.parse(await readFile(`${dir}/plugin.json`, "utf8")));
}

export type LaunchOptions = {
  /**
   * The directory the plugin is installed in. A host launch runs in it, and it is the
   * host side of a state mount, so a plugin that keeps state cannot be launched without
   * it.
   */
  cwd?: string;
  /**
   * Where the plugin's state lives on the host. Defaults to `state/` inside `cwd`, which
   * is what an install wants. A test passes its own, so running the suite cannot write
   * into the data an operator's plugin is keeping.
   */
  stateDir?: string;
  /** Defaults to whether the manifest declares an image. */
  container?: boolean;
  /**
   * Anything with a Docker-compatible `run` command. Podman is the usual reason to
   * change it, and rootless Podman is a common choice on servers.
   */
  runtime?: string;
  /**
   * Who is calling, as environment variables the plugin can read. A plugin that keeps
   * state has no other way to scope it: its manifest is identical on every install, so
   * without this every agent it serves shares one namespace. Core merges these last, so a
   * manifest cannot declare itself a different agent.
   */
  identity?: Record<string, string>;
};

export const defaultRuntime = () => process.env.FORGEPOD_CONTAINER_RUNTIME || "docker";

/**
 * Where a plugin's state directory is mounted. Core picks it rather than the manifest,
 * because the plugin reads FORGEPOD_STATE_DIR and never has to know it was a mount.
 */
export const CONTAINER_STATE = "/state";

const isContainer = (manifest: StdioManifest, opts: LaunchOptions) =>
  opts.container ?? Boolean(manifest.image);

function hostState(manifest: StdioManifest, opts: LaunchOptions): string {
  if (opts.stateDir) return resolve(opts.stateDir);
  if (!opts.cwd) {
    throw new Error(`plugin ${manifest.name} keeps state, but was launched with no directory`);
  }
  return resolve(opts.cwd, "state");
}

/**
 * Containerising a plugin is this rewrite and nothing else. Core holds no container
 * client, no image build logic and no port allocation, because stdio means the
 * container's own stdin and stdout are the channel.
 */
export function resolveLaunch(
  manifest: StdioManifest,
  opts: LaunchOptions = {},
): { command: string; args: string[] } {
  if (!isContainer(manifest, opts)) return { command: manifest.command, args: manifest.args };
  if (!manifest.image) throw new Error(`plugin ${manifest.name} has no image to run`);

  // Only the names are passed. Values reach the container through the process
  // environment, so a secret never lands in an argv another process can read.
  const names = new Set([
    ...Object.keys(manifest.env ?? {}),
    ...Object.keys(opts.identity ?? {}),
    ...(manifest.state ? ["FORGEPOD_STATE_DIR"] : []),
  ]);
  const env = [...names].flatMap((key) => ["-e", key]);
  const mount = manifest.state ? ["-v", `${hostState(manifest, opts)}:${CONTAINER_STATE}`] : [];
  return {
    command: opts.runtime ?? defaultRuntime(),
    args: ["run", "--rm", "-i", ...env, ...mount, manifest.image],
  };
}

/** Exported so the precedence between a manifest's env and core's identity is testable. */
export const launchEnv = (manifest: StdioManifest, opts: LaunchOptions = {}) => ({
  // Merged, not replaced: the transport's default environment is a filtered
  // allowlist, and dropping it breaks anything that needs PATH or HOME.
  ...getDefaultEnvironment(),
  ...manifest.env,
  // The plugin opens this path and never learns whether it was a mount or a directory on
  // the host, so the same plugin code works either way.
  ...(manifest.state
    ? {
        FORGEPOD_STATE_DIR: isContainer(manifest, opts)
          ? CONTAINER_STATE
          : hostState(manifest, opts),
      }
    : {}),
  ...opts.identity,
});

export async function connect(
  manifest: PluginManifest,
  opts: LaunchOptions = {},
): Promise<Client> {
  const client = new Client({ name: "forgepod", version: "0.1.0" });

  // ponytail: identity is stdio only. Over http it would have to become headers, and
  // proxies drop underscored header names, so leave the mapping until a plugin ships
  // over http.
  if (manifest.transport === "http") {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(manifest.url), {
        requestInit: { headers: manifest.headers },
      }),
    );
    return client;
  }

  // Created before the launch so the runtime does not create it, which on Linux leaves a
  // directory the host user cannot write to.
  if (manifest.state) await mkdir(hostState(manifest, opts), { recursive: true });

  await client.connect(
    new StdioClientTransport({
      ...resolveLaunch(manifest, opts),
      cwd: opts.cwd,
      env: launchEnv(manifest, opts),
      stderr: "pipe",
    }),
  );
  return client;
}
