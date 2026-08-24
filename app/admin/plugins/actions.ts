"use server";

import { revalidatePath } from "next/cache";
import { database } from "@/db";
import { inspect, installedPlugins } from "@/plugins/registry";
import { saveScan } from "@/plugins/store";

/**
 * Starting every plugin is slow and side-effecting, so it happens when an operator
 * asks rather than on every page load. What the page renders is the last scan.
 */
export async function rescan(): Promise<void> {
  const results = await Promise.all((await installedPlugins()).map(inspect));
  await saveScan(await database(), results, new Date().toISOString());
  revalidatePath("/admin/plugins");
}
