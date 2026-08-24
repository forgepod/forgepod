import { readFile } from "node:fs/promises";
import { z } from "zod";

const ToolRef = z.object({
  plugin: z.string().min(1),
  tool: z.string().min(1),
});

const TemplateAgentSchema = z.object({
  // The slug is what an author writes, never what a slugifier produces. It is the agent's
  // identity here, and the name an outside caller will eventually see.
  slug: z
    .string()
    .max(60)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase words joined by single hyphens"),
  name: z.string().min(1),
  model: z.string().min(1).optional(),
  systemPrompt: z.string().min(1),
  tools: z.array(ToolRef).default([]),
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

export async function loadTemplate(dir: string): Promise<TemplateManifest> {
  return TemplateManifest.parse(JSON.parse(await readFile(`${dir}/template.json`, "utf8")));
}
