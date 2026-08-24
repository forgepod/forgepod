import { expect, test } from "bun:test";
import { connect, loadManifest } from "./mcp";

const dir = "plugins/memory-mcp";
const manifest = await loadManifest(dir);
if (manifest.transport !== "stdio") throw new Error("expected a stdio manifest");

/** Runs on the host, so the check does not need a container runtime to be answering. */
const open = (slug: string) =>
  connect(manifest, {
    cwd: dir,
    container: false,
    identity: { FORGEPOD_AGENT_SLUG: slug, FORGEPOD_RUN_ID: `run-${slug}` },
  });

// callTool's return is a union whose legacy branch has no structuredContent, so the
// narrowing happens here once instead of at every call.
const structured = (result: unknown) =>
  (result as { structuredContent?: unknown }).structuredContent as {
    id?: number;
    forgotten?: boolean;
    memories?: { text: string }[];
  };

test("a memory belongs to the agent that stored it, and to no other", async () => {
  if (!(await Bun.file(`${dir}/.venv/bin/python`).exists())) {
    throw new Error("plugin venv missing, run: bun run plugin:setup");
  }

  // Unique per run, because this writes into the plugin's real state directory rather
  // than a copy of it, and a leftover row from a previous run would pass either way.
  const secret = `pumpkin${crypto.randomUUID().replaceAll("-", "")}`;
  const owner = await open("beam-checker");
  const stranger = await open("contract-reviewer");

  try {
    const stored = structured(
      await owner.callTool({ name: "remember", arguments: { text: `the safe word is ${secret}` } }),
    );
    expect(stored.id).toBeGreaterThan(0);

    const recalled = structured(
      await owner.callTool({ name: "recall", arguments: { query: secret } }),
    );
    expect(recalled.memories?.[0]?.text).toContain(secret);

    // The whole reason core sends identity: one slug's memory is invisible to another,
    // and an id guessed from elsewhere deletes nothing.
    const leak = structured(
      await stranger.callTool({ name: "recall", arguments: { query: secret } }),
    );
    expect(leak.memories).toEqual([]);

    const theft = structured(
      await stranger.callTool({ name: "forget", arguments: { id: stored.id } }),
    );
    expect(theft.forgotten).toBe(false);

    const gone = structured(await owner.callTool({ name: "forget", arguments: { id: stored.id } }));
    expect(gone.forgotten).toBe(true);
  } finally {
    await owner.close();
    await stranger.close();
  }
}, 30_000);

test("a query is treated as words, not as FTS5 syntax", async () => {
  const client = await open("beam-checker");
  try {
    // A bare hyphen is the NOT operator and an unbalanced quote is a syntax error, so
    // both of these fail loudly if the query is passed through as written.
    for (const query of ['what is the client"s name', "not -a valid * query"]) {
      const result = await client.callTool({ name: "recall", arguments: { query } });
      expect(result.isError ?? false).toBe(false);
    }
  } finally {
    await client.close();
  }
}, 30_000);
