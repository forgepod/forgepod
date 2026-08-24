"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { database } from "@/db";
import { createAgent, deleteAgent, loadAgent, publishVersion, type BoundToolRef } from "@/agents/store";

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
  const db = await database();

  await publishVersion(db, id, {
    model: String(form.get("model") ?? "").trim(),
    systemPrompt: String(form.get("systemPrompt") ?? ""),
    tools: parseTools(form),
  });

  // Saving publishes, and a silent publish is indistinguishable from a lost edit, so
  // the version that was written comes back in the URL and the page says so.
  const saved = await loadAgent(db, id);
  revalidatePath(`/admin/agents/${id}`);
  redirect(`/admin/agents/${id}?saved=${saved?.version ?? ""}`);
}

export async function deleteAgentAction(form: FormData): Promise<void> {
  await deleteAgent(await database(), String(form.get("id")));
  redirect("/admin/agents");
}
