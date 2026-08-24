import { expect, test } from "bun:test";
import { connect, defaultRuntime, loadManifest, resolveLaunch } from "./mcp";

const dir = "plugins/beam-mcp";
const image = "forgepod/beam-mcp:0.1.0";
const runtime = defaultRuntime();

// Loaded once so the launch tests and the container test agree on what is declared.
const manifest = await loadManifest(dir);
if (manifest.transport !== "stdio") throw new Error("expected a stdio manifest");

async function imageIsBuilt(): Promise<boolean> {
  try {
    const probe = Bun.spawn([runtime, "image", "inspect", image], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await probe.exited) === 0;
  } catch {
    return false;
  }
}

const built = await imageIsBuilt();
if (!built) {
  console.warn(`skipping the container test: ${runtime} has no ${image}, run \`bun run plugin:image\``);
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
