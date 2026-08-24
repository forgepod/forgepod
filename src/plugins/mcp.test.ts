import { expect, test } from "bun:test";
import { connect, loadManifest, resolveLaunch } from "./mcp";

const dir = "plugins/beam-mcp";

test("a stdio launch becomes a docker launch only when an image is declared", async () => {
  const manifest = await loadManifest(dir);
  if (manifest.transport !== "stdio") throw new Error("expected a stdio manifest");

  expect(resolveLaunch(manifest, false)).toEqual({
    command: ".venv/bin/python",
    args: ["server.py"],
  });
  expect(resolveLaunch(manifest, true)).toEqual({
    command: "docker",
    args: ["run", "--rm", "-i", "forgepod/beam-mcp:0.1.0"],
  });
  expect(() => resolveLaunch({ ...manifest, image: undefined }, true)).toThrow();
});

test("core discovers and calls a Python plugin's tools with no Python in core", async () => {
  if (!(await Bun.file(`${dir}/.venv/bin/python`).exists())) {
    throw new Error("plugin venv missing, run: bun run plugin:setup");
  }

  const client = await connect(await loadManifest(dir), { cwd: dir, useContainer: false });
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
}, 30_000);
