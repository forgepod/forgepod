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
