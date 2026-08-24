import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableTemplates } from "./registry";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forgepod-templates-"));

  await mkdir(join(root, "good"));
  await writeFile(
    join(root, "good", "template.json"),
    JSON.stringify({
      name: "good",
      version: "0.1.0",
      agents: [{ slug: "one", name: "One", systemPrompt: "a" }],
    }),
  );

  await mkdir(join(root, "broken"));
  await writeFile(join(root, "broken", "template.json"), "{ not json");

  // No template.json at all. This is not a template and must not be reported.
  await mkdir(join(root, "unrelated"));
  await writeFile(join(root, "unrelated", "readme.txt"), "nothing here");

  return root;
}

test("a directory without a template.json is skipped, a broken one is reported", async () => {
  const found = await availableTemplates(await fixture());

  expect(found.map((f) => f.dir.split("/").pop())).toEqual(["broken", "good"]);
  expect(found[0]?.error).toBeTruthy();
  expect(found[0]?.manifest).toBeUndefined();
  expect(found[1]?.manifest?.name).toBe("good");
  expect(found[1]?.error).toBeUndefined();
});

test("a missing root is empty rather than an error", async () => {
  expect(await availableTemplates("/no/such/directory")).toEqual([]);
});

test("every shipped template parses, and one of them binds tools", async () => {
  const found = await availableTemplates("templates");

  expect(found.map((f) => f.manifest?.name)).toEqual([
    "code-review",
    "legal-drafting",
    "structural-beam",
  ]);
  expect(found.map((f) => f.error)).toEqual([undefined, undefined, undefined]);

  const bound = found.flatMap((f) => f.manifest?.agents ?? []).filter((a) => a.tools.length > 0);
  expect(bound).toHaveLength(1);
  expect(bound[0]?.tools.map((t) => `${t.plugin}.${t.tool}`)).toEqual([
    "beam-mcp.beam_reactions",
    "beam-mcp.rectangular_section_modulus",
  ]);
});
