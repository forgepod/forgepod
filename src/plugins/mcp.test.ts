import { expect, test } from "bun:test";
import {
  CONTAINER_STATE,
  connect,
  defaultRuntime,
  launchEnv,
  loadManifest,
  resolveLaunch,
} from "./mcp";

const dir = "plugins/beam-mcp";
const image = "forgepod/beam-mcp:0.1.0";
const runtime = defaultRuntime();

// Loaded once so the launch tests and the container test agree on what is declared.
const manifest = await loadManifest(dir);
if (manifest.transport !== "stdio") throw new Error("expected a stdio manifest");

async function runtimeAnswers(args: string[]): Promise<boolean> {
  try {
    const probe = Bun.spawn([runtime, ...args], { stdout: "ignore", stderr: "ignore" });
    return (await probe.exited) === 0;
  } catch {
    return false;
  }
}

// Two different reasons to skip, and saying the wrong one sends a reader to build an
// image that already exists. A runtime that does not answer is the likelier of the two,
// because the default is docker and a machine may only have podman.
const runtimeUp = await runtimeAnswers(["info"]);
const built = runtimeUp && (await runtimeAnswers(["image", "inspect", image]));
if (!built) {
  console.warn(
    runtimeUp
      ? `skipping the container tests: ${runtime} has no ${image}, run \`bun run plugin:image\``
      : `skipping the container tests: ${runtime} is not answering. Set FORGEPOD_CONTAINER_RUNTIME to the runtime you actually use.`,
  );
}

test("a stdio launch becomes a container launch only when an image is declared", () => {
  expect(resolveLaunch(manifest, { container: false })).toEqual({
    command: ".venv/bin/python",
    args: ["server.py"],
  });
  expect(resolveLaunch(manifest, { container: true, runtime: "docker" })).toEqual({
    command: "docker",
    args: ["run", "--rm", "-i", image],
  });
  expect(() => resolveLaunch({ ...manifest, image: undefined }, { container: true })).toThrow();
});

test("the container runtime is swappable, since a server may only have podman", () => {
  expect(resolveLaunch(manifest, { container: true, runtime: "podman" }).command).toBe("podman");
});

test("a plugin is told which agent and run is calling it, and cannot claim otherwise", () => {
  const identity = { FORGEPOD_AGENT_SLUG: "beam-checker", FORGEPOD_RUN_ID: "run-1" };
  const declared = { ...manifest, env: { API_KEY: "x", FORGEPOD_AGENT_SLUG: "someone-else" } };

  // Argv carries names only, once each, so the value travels in the environment.
  expect(resolveLaunch(declared, { container: true, runtime: "docker", identity }).args).toEqual([
    "run",
    "--rm",
    "-i",
    "-e",
    "API_KEY",
    "-e",
    "FORGEPOD_AGENT_SLUG",
    "-e",
    "FORGEPOD_RUN_ID",
    image,
  ]);

  expect(launchEnv(declared, { identity })).toMatchObject({
    API_KEY: "x",
    FORGEPOD_AGENT_SLUG: "beam-checker",
    FORGEPOD_RUN_ID: "run-1",
  });
});

test("core discovers and calls a Python plugin's tools with no Python in core", async () => {
  if (!(await Bun.file(`${dir}/.venv/bin/python`).exists())) {
    throw new Error("plugin venv missing, run: bun run plugin:setup");
  }
  await expectBeamTools(await connect(manifest, { cwd: dir, container: false }));
}, 30_000);

test.skipIf(!built)("the same plugin behaves identically inside a container", async () => {
  await expectBeamTools(await connect(manifest, { container: true }));
}, 60_000);

async function expectBeamTools(client: Awaited<ReturnType<typeof connect>>) {
  try {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "beam_reactions",
      "rectangular_section_modulus",
    ]);

    const result = await client.callTool({
      name: "beam_reactions",
      arguments: { span_m: 6, load_kn: 10, load_from_left_m: 2 },
    });

    // Reactions split the load by the inverse of the lever arms, so a load one
    // third along the span puts two thirds of it on the near support.
    expect(result.structuredContent).toMatchObject({
      reaction_left_kn: expect.closeTo(6.666667, 5),
      reaction_right_kn: expect.closeTo(3.333333, 5),
      max_moment_knm: expect.closeTo(13.333333, 5),
    });
  } finally {
    await client.close();
  }
}

test("a plugin that keeps state is given a directory that outlives the run", () => {
  const stateful = { ...manifest, state: true };
  const opts = { container: true, runtime: "docker", cwd: "plugins/memory-mcp" };
  const host = `${process.cwd()}/plugins/memory-mcp/state`;

  expect(resolveLaunch(stateful, opts).args).toEqual([
    "run",
    "--rm",
    "-i",
    "-e",
    "FORGEPOD_STATE_DIR",
    "-v",
    `${host}:${CONTAINER_STATE}`,
    image,
  ]);

  // The plugin opens one path either way, so the same code runs on the host and in a
  // container. Only the value differs.
  expect(launchEnv(stateful, opts).FORGEPOD_STATE_DIR).toBe(CONTAINER_STATE);
  expect(launchEnv(stateful, { ...opts, container: false }).FORGEPOD_STATE_DIR).toBe(host);

  // Silently writing into the process's working directory would put one plugin's state
  // wherever core happened to be started from.
  expect(() => resolveLaunch(stateful, { container: true })).toThrow(/launched with no directory/);
});

test("a stateless plugin gets no mount and no state variable", () => {
  const args = resolveLaunch(manifest, { container: true, cwd: dir }).args;
  expect(args).not.toContain("-v");
  expect(launchEnv(manifest, { cwd: dir }).FORGEPOD_STATE_DIR).toBeUndefined();
});
