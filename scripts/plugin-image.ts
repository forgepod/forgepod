/**
 * Builds an image for every plugin that ships a Dockerfile, tagged with the name its
 * own manifest declares so the tag cannot drift from what the core will launch.
 *
 * A shell one-liner would do the same, except `bun run` does not load `.env`, so
 * FORGEPOD_CONTAINER_RUNTIME never reached the one command that needs it. Run through
 * bun instead and the setting is read the same way the server reads it.
 */
import { readdir } from "node:fs/promises";

const runtime = process.env.FORGEPOD_CONTAINER_RUNTIME || "docker";
const root = process.env.FORGEPOD_PLUGIN_DIR || "plugins";

for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = `${root}/${entry.name}`;
  if (!(await Bun.file(`${dir}/Dockerfile`).exists())) continue;

  const { image } = await Bun.file(`${dir}/plugin.json`).json();
  if (!image) {
    console.log(`${dir}: no image declared, skipped`);
    continue;
  }

  console.log(`${dir}: building ${image} with ${runtime}`);
  const built = Bun.spawnSync([runtime, "build", "-t", image, dir], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (built.exitCode !== 0) process.exit(built.exitCode ?? 1);
}
