"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { database } from "@/db";
import { providerFromEnv } from "@/agents/providers";
import { runAgent, runnableTools } from "@/agents/run";
import { createAgent, loadAgent, publishVersion, type BoundToolRef } from "@/agents/store";

const parseTools = (form: FormData): BoundToolRef[] =>
  form
    .getAll("tool")
    .map(String)
    .map((value) => value.split("::"))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([pluginName, toolName]) => ({ pluginName, toolName }));

export async function createAgentAction(form: FormData): Promise<void> {
  const name = String(form.get("name") ?? "").trim();
  if (!name) return;

  const id = await createAgent(await database(), { name });
  redirect(`/admin/agents/${id}`);
}

export async function saveAgentAction(form: FormData): Promise<void> {
  const id = String(form.get("id"));
  await publishVersion(await database(), id, {
    model: String(form.get("model") ?? "").trim(),
    systemPrompt: String(form.get("systemPrompt") ?? ""),
    tools: parseTools(form),
  });
  revalidatePath(`/admin/agents/${id}`);
}

/**
 * Saves first, then runs. Testing a prompt you have not saved would report on something
 * that no longer exists the moment the page reloads.
 */
export async function runAgentAction(form: FormData): Promise<void> {
  const id = String(form.get("id"));
  await saveAgentAction(form);

  const db = await database();
  const agent = await loadAgent(db, id);
  if (!agent) return;

  await runAgent({
    db,
    provider: providerFromEnv(),
    version: { id: agent.versionId, model: agent.model, systemPrompt: agent.systemPrompt },
    tools: await runnableTools(db, agent.versionId),
    input: String(form.get("input") ?? ""),
  });

  revalidatePath(`/admin/agents/${id}`);
}
