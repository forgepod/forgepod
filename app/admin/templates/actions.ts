"use server";

import { redirect } from "next/navigation";
import { database } from "@/db";
import { installTemplate } from "@/templates/install";
import { availableTemplates } from "@/templates/registry";

/**
 * The form field decides which file gets read, so the directory is matched against what
 * the scan actually found rather than trusted as a path.
 */
export async function install(formData: FormData): Promise<void> {
  const dir = String(formData.get("dir") ?? "");
  const entry = (await availableTemplates()).find((t) => t.dir === dir);
  if (!entry?.manifest) throw new Error(`No such template: ${dir}`);

  await installTemplate(await database(), entry.manifest);

  // What a template produces is agents, so that is where the operator wants to land.
  redirect("/admin/agents");
}
