"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { database } from "@/db";
import { bindHook, unbindHook, type HookName } from "@/agents/hooks";
import { agentOwner, createAgent, deleteAgent, loadAgent, publishVersion, type BoundToolRef } from "@/agents/store";
import { guard } from "@/auth/actor";
import { resolveApproval } from "@/plugins/approvals";

const parseTools = (form: FormData): BoundToolRef[] =>
  form
    .getAll("tool")
    .map(String)
    .map((value) => value.split("::"))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([pluginName, toolName]) => ({ pluginName, toolName }));

export async function createAgentAction(form: FormData): Promise<void> {
  const verdict = await guard(await headers(), "agent.create");
  if (!verdict.ok) redirect(`/admin/agents?hookError=${encodeURIComponent(verdict.reason)}`);

  const name = String(form.get("name") ?? "").trim();
  if (!name) return;

  const id = await createAgent(await database(), { name, ownerId: verdict.actor.userId });
  redirect(`/admin/agents/${id}`);
}

export async function saveAgentAction(form: FormData): Promise<void> {
  const id = String(form.get("id"));

  const verdict = await guard(await headers(), "agent.edit");
  if (!verdict.ok) redirect(`/admin/agents/${id}?hookError=${encodeURIComponent(verdict.reason)}`);

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
  const id = String(form.get("id"));
  const db = await database();

  const owner = await agentOwner(db, id);
  const verdict = await guard(await headers(), "agent.delete", owner ?? { ownerId: null });
  if (!verdict.ok) redirect(`/admin/agents/${id}?hookError=${encodeURIComponent(verdict.reason)}`);

  await deleteAgent(db, id);
  redirect("/admin/agents");
}

/**
 * Binding can be refused, and the refusal is the point: a filter hook needs a trusted
 * plugin. The failure is carried back in the URL rather than thrown, because a server
 * action that throws replaces the page with an error screen the operator cannot act on.
 *
 * `redirect` works by throwing, so it stays outside the catch that would swallow it.
 */
export async function bindHookAction(form: FormData): Promise<void> {
  const id = String(form.get("id"));

  const verdict = await guard(await headers(), "hook.bind");
  if (!verdict.ok) redirect(`/admin/agents/${id}?hookError=${encodeURIComponent(verdict.reason)}`);

  const [pluginName, toolName] = String(form.get("handler") ?? "").split("::");
  const hook = String(form.get("hook") ?? "") as HookName;
  const priority = Number(form.get("priority"));

  let failure: string | null = null;
  if (!pluginName || !toolName) {
    failure = "Pick the plugin tool that handles the hook.";
  } else {
    try {
      await bindHook(await database(), {
        agentId: id,
        hook,
        pluginName,
        toolName,
        priority: Number.isFinite(priority) ? priority : 10,
      });
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
  }

  revalidatePath(`/admin/agents/${id}`);
  redirect(failure ? `/admin/agents/${id}?hookError=${encodeURIComponent(failure)}` : `/admin/agents/${id}`);
}

export async function unbindHookAction(form: FormData): Promise<void> {
  const id = String(form.get("id"));

  const verdict = await guard(await headers(), "hook.bind");
  if (!verdict.ok) redirect(`/admin/agents/${id}?hookError=${encodeURIComponent(verdict.reason)}`);

  await unbindHook(await database(), String(form.get("binding")));
  revalidatePath(`/admin/agents/${id}`);
  redirect(`/admin/agents/${id}`);
}

/**
 * The operator's answer to a call a plugin is holding. Core carries the answer to the
 * plugin and stores nothing: which calls need one, and what an answer means, are the
 * plugin's own business.
 */
export async function resolveApprovalAction(form: FormData): Promise<void> {
  const id = String(form.get("id"));

  const verdict = await guard(await headers(), "approval.resolve");
  if (!verdict.ok) redirect(`/admin/agents/${id}?hookError=${encodeURIComponent(verdict.reason)}`);

  let failure: string | null = null;
  try {
    await resolveApproval(
      await database(),
      String(form.get("plugin")),
      Number(form.get("approval")),
      String(form.get("decision")),
    );
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  revalidatePath(`/admin/agents/${id}`);
  redirect(failure ? `/admin/agents/${id}?hookError=${encodeURIComponent(failure)}` : `/admin/agents/${id}`);
}
