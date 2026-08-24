import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { connect, loadManifest } from "./mcp";

const dir = "plugins/memory-mcp";
const manifest = await loadManifest(dir);
if (manifest.transport !== "stdio") throw new Error("expected a stdio manifest");

/** Runs on the host, so the check does not need a container runtime to be answering. */
// Its own directory, so the suite never touches what an install has stored.
const stateDir = `${tmpdir()}/forgepod-memory-test-${crypto.randomUUID()}`;

const open = (slug: string, install = "install-a") =>
  connect(manifest, {
    cwd: dir,
    stateDir,
    container: false,
    identity: {
      FORGEPOD_INSTALL_ID: install,
      FORGEPOD_AGENT_SLUG: slug,
      FORGEPOD_RUN_ID: `run-${slug}`,
    },
  });

// callTool's return is a union whose legacy branch has no structuredContent, so the
// narrowing happens here once instead of at every call.
const structured = (result: unknown) =>
  (result as { structuredContent?: unknown }).structuredContent as {
    id?: number;
    forgotten?: boolean;
    memories?: { id: number; text: string }[];
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

test("a recall is a question, so one shared word is enough to find a memory", async () => {
  const token = `girder${crypto.randomUUID().replaceAll("-", "")}`;
  const client = await open("recall-shape");

  try {
    const stored = [
      `the standard span is ${token} metres`,
      "results are always wanted in kilonewtons",
    ];
    const ids: number[] = [];
    for (const text of stored) {
      ids.push(structured(await client.callTool({ name: "remember", arguments: { text } }))!.id!);
    }

    // Joining the words with AND instead returns nothing here, which is what shipped
    // first: a question shares one word with the memory it is looking for, not all of
    // them.
    const found = structured(
      await client.callTool({
        name: "recall",
        arguments: { query: "what span do I usually use?" },
      }),
    );
    expect(found.memories?.[0]?.text).toContain(token);
  } finally {
    const left = structured(await client.callTool({ name: "recall", arguments: {} })).memories;
    for (const memory of left ?? []) {
      await client.callTool({ name: "forget", arguments: { id: memory.id } });
    }
    await client.close();
  }
}, 30_000);

test("two installs of one template do not share what its agent remembers", async () => {
  const secret = `trestle${crypto.randomUUID().replaceAll("-", "")}`;
  // The same slug on purpose. A slug is authored in the template, so every install of it
  // has this one, and the install id is the only thing telling these two apart.
  const here = await open("contract-reviewer", "install-a");
  const elsewhere = await open("contract-reviewer", "install-b");

  try {
    const stored = structured(
      await here.callTool({ name: "remember", arguments: { text: `the safe word is ${secret}` } }),
    );

    const mine = structured(await here.callTool({ name: "recall", arguments: { query: secret } }));
    expect(mine.memories?.[0]?.text).toContain(secret);

    const theirs = structured(
      await elsewhere.callTool({ name: "recall", arguments: { query: secret } }),
    );
    expect(theirs.memories).toEqual([]);

    const theft = structured(
      await elsewhere.callTool({ name: "forget", arguments: { id: stored.id } }),
    );
    expect(theft.forgotten).toBe(false);

    const gone = structured(await here.callTool({ name: "forget", arguments: { id: stored.id } }));
    expect(gone.forgotten).toBe(true);
  } finally {
    await here.close();
    await elsewhere.close();
  }
}, 30_000);
