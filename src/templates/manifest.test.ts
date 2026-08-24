import { expect, test } from "bun:test";
import { TemplateManifest } from "./manifest";

const agent = {
  slug: "contract-reviewer",
  name: "Contract Reviewer",
  systemPrompt: "Read it.",
};

const minimal = { name: "legal-drafting", version: "0.1.0", agents: [agent] };

test("a minimal manifest parses, and the optional fields default", () => {
  const parsed = TemplateManifest.parse(minimal);

  expect(parsed.requires).toEqual([]);
  expect(parsed.agents[0]?.tools).toEqual([]);
  expect(parsed.agents[0]?.model).toBeUndefined();
});

test("tool references survive parsing", () => {
  const parsed = TemplateManifest.parse({
    ...minimal,
    requires: ["beam-mcp"],
    agents: [
      {
        slug: "beam-checker",
        name: "Beam Checker",
        model: "claude-opus-5",
        systemPrompt: "Check beams.",
        tools: [{ plugin: "beam-mcp", tool: "beam_reactions" }],
      },
    ],
  });

  expect(parsed.agents[0]?.tools).toEqual([{ plugin: "beam-mcp", tool: "beam_reactions" }]);
  expect(parsed.agents[0]?.model).toBe("claude-opus-5");
});

test("a slug that is not a lowercase hyphenated word is rejected", () => {
  for (const slug of ["Contract Reviewer", "contract_reviewer", "-leading", "trailing-", ""]) {
    expect(() => TemplateManifest.parse({ ...minimal, agents: [{ ...agent, slug }] })).toThrow();
  }
});

test("two agents claiming one slug is rejected", () => {
  expect(() =>
    TemplateManifest.parse({
      ...minimal,
      agents: [
        { slug: "twin", name: "One", systemPrompt: "a" },
        { slug: "twin", name: "Two", systemPrompt: "b" },
      ],
    }),
  ).toThrow(/duplicate agent slug: twin/);
});

test("a manifest with no agents is rejected", () => {
  expect(() => TemplateManifest.parse({ ...minimal, agents: [] })).toThrow();
});

test("an empty system prompt is rejected", () => {
  expect(() =>
    TemplateManifest.parse({ ...minimal, agents: [{ ...agent, systemPrompt: "" }] }),
  ).toThrow();
});
