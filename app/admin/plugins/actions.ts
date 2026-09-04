"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { trustPlugin } from "@/agents/hooks";
import { database } from "@/db";
import { inspect, installedPlugins } from "@/plugins/registry";
import { saveScan } from "@/plugins/store";
import { guard } from "@/auth/actor";

/**
 * Starting every plugin is slow and side-effecting, so it happens when an operator
 * asks rather than on every page load. What the page renders is the last scan.
 */
export async function rescan(): Promise<void> {
  const verdict = await guard(await headers(), "plugin.rescan");
  if (!verdict.ok) redirect(`/admin/plugins?hookError=${encodeURIComponent(verdict.reason)}`);

  const results = await Promise.all((await installedPlugins()).map(inspect));
  await saveScan(await database(), results, new Date().toISOString());
  revalidatePath("/admin/plugins");
}

/**
 * Trust is granted here and nowhere else. A plugin cannot ask for it, and it decides
 * only one thing: whether the plugin may sit in front of every tool call an agent makes.
 */
export async function setTrust(form: FormData): Promise<void> {
  const verdict = await guard(await headers(), "plugin.setTrust");
  if (!verdict.ok) redirect(`/admin/plugins?hookError=${encodeURIComponent(verdict.reason)}`);

  await trustPlugin(await database(), String(form.get("plugin")), form.get("trusted") === "yes");
  revalidatePath("/admin/plugins");
}
