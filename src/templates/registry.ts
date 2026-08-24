import { readdir } from "node:fs/promises";
import { loadTemplate, type TemplateManifest } from "./manifest";

/** A directory holding a template.json is a template that can be installed. */
export const templateRoot = () => process.env.FORGEPOD_TEMPLATE_DIR || "templates";

export type Available = { dir: string; manifest?: TemplateManifest; error?: string };

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function availableTemplates(root = templateRoot()): Promise<Available[]> {
  let names: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const found = await Promise.all(
    names.map(async (name): Promise<Available | null> => {
      const dir = `${root}/${name}`;
      try {
        return { dir, manifest: await loadTemplate(dir) };
      } catch (e) {
        // A directory with no manifest is not a template. A directory with a broken one
        // is, and hiding it is how an author loses an hour.
        if (describe(e).includes("ENOENT")) return null;
        return { dir, error: describe(e) };
      }
    }),
  );

  return found.filter((x) => x !== null).sort((a, b) => a.dir.localeCompare(b.dir));
}
