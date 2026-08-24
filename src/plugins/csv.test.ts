import { expect, test } from "bun:test";
import { connect, defaultRuntime, loadManifest } from "./mcp";

const dir = "plugins/csv-mcp";
const image = "forgepod/csv-mcp:0.1.0";
const runtime = defaultRuntime();
const manifest = await loadManifest(dir);

async function runtimeAnswers(args: string[]): Promise<boolean> {
  try {
    const probe = Bun.spawn([runtime, ...args], { stdout: "ignore", stderr: "ignore" });
    return (await probe.exited) === 0;
  } catch {
    return false;
  }
}

// Container only, unlike the Python plugins, which also run on the host while they are
// being developed. Nothing here needs the host path: what this plugin proves is that a
// language core shares nothing with can answer, and the image is where that is true.
const runtimeUp = await runtimeAnswers(["info"]);
const built = runtimeUp && (await runtimeAnswers(["image", "inspect", image]));
if (!built) {
  console.warn(
    runtimeUp
      ? `skipping the csv plugin tests: ${runtime} has no ${image}, run \`bun run plugin:image\``
      : `skipping the csv plugin tests: ${runtime} is not answering.`,
  );
}

const structured = (result: unknown) =>
  (result as { structuredContent?: unknown }).structuredContent as Record<string, number | string>;

const sales = "region,units,revenue\nnorth,3,1200.5\nsouth,4,800\neast,1,99.5";

test.skipIf(!built)("a plugin written with no SDK answers like any other", async () => {
  const client = await connect(manifest, { container: true });

  try {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["csv_column_stats", "csv_to_markdown"]);
    // Declared by hand in the JSON the server prints. Without it the core would get a
    // string to re-parse rather than data.
    expect(tools[0]?.outputSchema).toBeDefined();

    const table = structured(
      await client.callTool({ name: "csv_to_markdown", arguments: { csv: sales } }),
    );
    expect(table.rows).toBe(3);
    expect(table.columns).toBe(3);
    expect(String(table.markdown).split("\n")[0]).toBe("| region | units | revenue |");

    const stats = structured(
      await client.callTool({
        name: "csv_column_stats",
        arguments: { csv: sales, column: "revenue" },
      }),
    );
    expect(stats).toMatchObject({ count: 3, sum: 2100, min: 99.5, max: 1200.5, mean: 700 });
  } finally {
    await client.close();
  }
}, 60_000);

test.skipIf(!built)("a refused input comes back as a result the model can read", async () => {
  const client = await connect(manifest, { container: true });

  try {
    // A column with one word in it would otherwise produce a sum that looks right.
    const spoiled = await client.callTool({
      name: "csv_column_stats",
      arguments: { csv: "units\n3\nmany\n1", column: "units" },
    });
    expect(spoiled.isError).toBe(true);
    expect(JSON.stringify(spoiled.content)).toContain("not a number");

    const missing = await client.callTool({
      name: "csv_column_stats",
      arguments: { csv: sales, column: "profit" },
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("no column named profit");
  } finally {
    await client.close();
  }
}, 60_000);

test.skipIf(!built)("a quoted line break stays one field, and a pipe stays one cell", async () => {
  const client = await connect(manifest, { container: true });

  try {
    const table = structured(
      await client.callTool({
        name: "csv_to_markdown",
        arguments: { csv: 'note,owner\n"first line\nsecond line",a|b\n' },
      }),
    );
    expect(table.rows).toBe(1);
    // A markdown table cannot hold a line break, so the cell keeps its content without
    // breaking the row it sits in.
    expect(table.markdown).toContain("first line<br>second line");
    expect(String(table.markdown).split("\n")).toHaveLength(3);
    expect(table.markdown).toContain("a\\|b");
  } finally {
    await client.close();
  }
}, 60_000);
