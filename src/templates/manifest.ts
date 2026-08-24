import { readFile } from "node:fs/promises";
import { z } from "zod";

const ToolRef = z.object({
  plugin: z.string().min(1),
  tool: z.string().min(1),
});

/**
 * Joined in this order at install, with a blank line between the parts that are present
 * and no headings added. The order is part of the manifest's contract: a template that
 * ships with an outside author's name on it cannot be reordered later without changing
 * what their agent says.
 */
const SECTIONS = ["persona", "instructions", "guardrails", "outputFormat"] as const;

const TemplateAgentSchema = z
  .object({
    // The slug is what an author writes, never what a slugifier produces. It is the agent's
    // identity here, and the name an outside caller will eventually see.
    slug: z
      .string()
      .max(60)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase words joined by single hyphens"),
    name: z.string().min(1),
    model: z.string().min(1).optional(),
    // One blob, for an author who wants to write the prompt as prose.
    systemPrompt: z.string().min(1).optional(),
    persona: z.string().min(1).optional(),
    instructions: z.string().min(1).optional(),
    guardrails: z.string().min(1).optional(),
    outputFormat: z.string().min(1).optional(),
    tools: z.array(ToolRef).default([]),
  })
  .superRefine((agent, ctx) => {
    const named = SECTIONS.filter((section) => agent[section]);
    // Accepting both would mean deciding where the blob sits among the sections, and any
    // answer to that is a rule an author has to memorise.
    if (agent.systemPrompt && named.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `${agent.slug}: use systemPrompt or the named sections, not both`,
      });
    }
    if (!agent.systemPrompt && named.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: `${agent.slug}: needs systemPrompt, or one of ${SECTIONS.join(", ")}`,
      });
    }
  });

export const TemplateManifest = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    requires: z.array(z.string().min(1)).default([]),
    agents: z.array(TemplateAgentSchema).min(1),
  })
  .superRefine((manifest, ctx) => {
    // Two agents claiming one slug can never install, and the collision check against the
    // database would blame existing data for the author's mistake.
    const seen = new Set<string>();
    for (const agent of manifest.agents) {
      if (seen.has(agent.slug)) {
        ctx.addIssue({ code: "custom", message: `duplicate agent slug: ${agent.slug}` });
      }
      seen.add(agent.slug);
    }
  });

export type TemplateManifest = z.infer<typeof TemplateManifest>;
export type TemplateAgent = z.infer<typeof TemplateAgentSchema>;

/** The one place the sections become a prompt, so install and any preview agree. */
export const composePrompt = (agent: TemplateAgent): string =>
  agent.systemPrompt ?? SECTIONS.map((section) => agent[section]).filter(Boolean).join("\n\n");

export async function loadTemplate(dir: string): Promise<TemplateManifest> {
  return TemplateManifest.parse(JSON.parse(await readFile(`${dir}/template.json`, "utf8")));
}
