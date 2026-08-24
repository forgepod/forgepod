import { expect, test } from "bun:test";
import { TemplateManifest, composePrompt, loadTemplate } from "./manifest";

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

test("named sections join in a fixed order, and only the ones present", () => {
  const parsed = TemplateManifest.parse({
    ...minimal,
    agents: [
      {
        slug: "contract-reviewer",
        name: "Contract Reviewer",
        // Written out of order on purpose: what an author types is not the order the
        // agent reads.
        outputFormat: "One line per finding.",
        persona: "You review contracts.",
        guardrails: "Not legal advice.",
      },
    ],
  });

  expect(composePrompt(parsed.agents[0]!)).toBe(
    "You review contracts.\n\nNot legal advice.\n\nOne line per finding.",
  );
});

test("a systemPrompt is passed through untouched", () => {
  const parsed = TemplateManifest.parse(minimal);
  expect(composePrompt(parsed.agents[0]!)).toBe("Read it.");
});

test("an agent gives either a systemPrompt or sections, and needs one of them", () => {
  const both = { ...agent, persona: "You review contracts." };
  expect(() => TemplateManifest.parse({ ...minimal, agents: [both] })).toThrow(/not both/);

  const neither = { slug: "contract-reviewer", name: "Contract Reviewer" };
  expect(() => TemplateManifest.parse({ ...minimal, agents: [neither] })).toThrow(
    /needs systemPrompt/,
  );
});

test("the shipped templates parse, in both prompt shapes", async () => {
  const sections = await loadTemplate("templates/legal-drafting");
  expect(composePrompt(sections.agents[0]!)).toStartWith("You review contract text");

  const blob = await loadTemplate("templates/code-review");
  expect(composePrompt(blob.agents[0]!)).toStartWith("You review a diff");
});
