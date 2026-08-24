import { database } from "@/db";
import { checkTemplate, describeProblem, type Problem } from "@/templates/install";
import { availableTemplates, type Available } from "@/templates/registry";
import { Masthead } from "../../masthead";
import { PageHeader } from "../../page-header";
import { install } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Templates" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default async function TemplatesPage() {
  const db = await database();
  const found = await availableTemplates();

  const entries = await Promise.all(
    found.map(async (entry) => ({
      entry,
      problems: entry.manifest ? await checkTemplate(db, entry.manifest) : [],
    })),
  );

  return (
    <main className="sheet">
      <Masthead here="templates" />

      <PageHeader
        title="Templates"
        status={found.length > 0 ? plural(found.length, "template") : "None found"}
        note="A template is a directory holding a template.json. Installing one creates its agents once and then forgets it, so what you get afterwards are ordinary agents you can edit and delete."
      />

      {entries.map(({ entry, problems }) => (
        <TemplateEntry key={entry.dir} entry={entry} problems={problems} />
      ))}
    </main>
  );
}

function TemplateEntry({ entry, problems }: { entry: Available; problems: Problem[] }) {
  const manifest = entry.manifest;

  if (!manifest) {
    return (
      <section className="plugin">
        <div className="plugin-head">
          <h2>{entry.dir}</h2>
          <span className="state state-down">unreadable</span>
        </div>
        <div className="failure">
          <p>{entry.error}</p>
          <p>Fix template.json in that directory, then reload this page.</p>
        </div>
      </section>
    );
  }

  const ready = problems.length === 0;
  const bindings = manifest.agents.reduce((n, a) => n + a.tools.length, 0);

  return (
    <section className="plugin">
      <div className="plugin-head">
        <h2>
          {manifest.name} <span className="version">{manifest.version}</span>
        </h2>
        <span className={`state ${ready ? "state-up" : "state-down"}`}>
          {ready ? "ready to install" : plural(problems.length, "problem")}
        </span>
      </div>

      {manifest.description ? <p className="desc">{manifest.description}</p> : null}

      <dl className="meta">
        <dt>source</dt>
        <dd>{entry.dir}</dd>
        <dt>creates</dt>
        <dd>
          {plural(manifest.agents.length, "agent")}
          {bindings > 0 ? `, ${plural(bindings, "tool binding")}` : ", no tools"}
        </dd>
        <dt>needs</dt>
        <dd>{manifest.requires.length > 0 ? manifest.requires.join(", ") : "no plugins"}</dd>
      </dl>

      {ready ? null : (
        <div className="failure">
          {problems.map((problem) => (
            <p key={describeProblem(problem)}>{describeProblem(problem)}</p>
          ))}
          {problems.some((p) => p.kind === "missing-plugin") ? (
            <p>Scan plugins first if one of them is installed but has never been read.</p>
          ) : null}
        </div>
      )}

      <form action={install}>
        <input type="hidden" name="dir" value={entry.dir} />
        <button type="submit" className="action" disabled={!ready}>
          Install
        </button>
      </form>
    </section>
  );
}
