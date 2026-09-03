import type { Kysely } from "kysely";
import { loadAgent, publishVersion } from "../agents/store";
import type { Schema } from "../db/schema";
import { authored, checkTemplate, describeProblem, type Problem, sourceHash, writeAgent } from "./install";
import type { TemplateManifest } from "./manifest";

/**
 * `edited` is the whole point of this file. An agent whose current content no longer
 * hashes to what the template wrote is one an operator has tuned, and a template upgrade
 * that overwrites it destroys the customisation the install was worth having for. So it
 * is reported and skipped, never merged and never overwritten.
 *
 * `orphan` is the same restraint in the other direction: an agent a newer template no
 * longer mentions is left standing rather than deleted, because nothing here can tell an
 * author's removal from a rename.
 */
export type Change =
  | { kind: "create"; slug: string }
  | { kind: "update"; slug: string; agentId: string; from: string; republish: boolean }
  | { kind: "unchanged"; slug: string }
  | { kind: "edited"; slug: string }
  | { kind: "orphan"; slug: string };

/** Tenseless on purpose: `diff` and `upgrade` print the same lines about the same plan. */
export function describeChange(change: Change, to: string): string {
  switch (change.kind) {
    case "create":
      return `${change.slug}: new in ${to}`;
    case "update":
      return change.republish
        ? `${change.slug}: ${change.from} to ${to}, content changed`
        : `${change.slug}: ${change.from} to ${to}, content identical`;
    case "unchanged":
      return `${change.slug}: already ${to}`;
    case "edited":
      return `${change.slug}: edited since install, left alone`;
    case "orphan":
      return `${change.slug}: not in ${to} any more, left alone`;
  }
}

type Recorded = { agentId: string; slug: string; installedVersion: string; sourceHash: string };

async function recordedFor(db: Kysely<Schema>, template: string): Promise<Recorded[]> {
  return db
    .selectFrom("template_installs")
    .innerJoin("agents", "agents.id", "template_installs.agent_id")
    .where("template_installs.template_name", "=", template)
    .select([
      "template_installs.agent_id as agentId",
      "agents.slug as slug",
      "template_installs.installed_version as installedVersion",
      "template_installs.source_hash as sourceHash",
    ])
    .execute();
}

/**
 * What an upgrade would do, without doing any of it. The same function backs `diff` and
 * `upgrade`, so what an operator is shown is what runs, rather than two descriptions that
 * can drift.
 */
export async function planUpgrade(
  db: Kysely<Schema>,
  manifest: TemplateManifest,
): Promise<{ changes: Change[]; problems: Problem[] }> {
  const recorded = await recordedFor(db, manifest.name);
  if (recorded.length === 0) {
    throw new Error(`${manifest.name} has never been installed here, so there is nothing to upgrade`);
  }

  const bySlug = new Map(recorded.map((r) => [r.slug, r]));
  const problems = await checkTemplate(db, manifest, new Set(bySlug.keys()));
  const changes: Change[] = [];

  for (const agent of manifest.agents) {
    const row = bySlug.get(agent.slug);
    if (!row) {
      changes.push({ kind: "create", slug: agent.slug });
      continue;
    }

    const current = await loadAgent(db, row.agentId);
    // An agent with no published version cannot be compared, and cannot have been
    // written by this template either, so it is left where it stands.
    if (!current || sourceHash(current) !== row.sourceHash) {
      changes.push({ kind: "edited", slug: agent.slug });
      continue;
    }

    const wanted = sourceHash(authored(agent));
    if (wanted === row.sourceHash && row.installedVersion === manifest.version) {
      changes.push({ kind: "unchanged", slug: agent.slug });
      continue;
    }

    changes.push({
      kind: "update",
      slug: agent.slug,
      agentId: row.agentId,
      from: row.installedVersion,
      republish: wanted !== row.sourceHash,
    });
  }

  const wanted = new Set(manifest.agents.map((a) => a.slug));
  for (const row of recorded) {
    if (!wanted.has(row.slug)) changes.push({ kind: "orphan", slug: row.slug });
  }

  return { changes, problems };
}

/**
 * Recomputes the plan and applies it in one transaction, rather than taking the plan
 * `diff` printed: between the two commands an operator may have edited an agent, and
 * acting on the older answer is exactly the overwrite this whole file exists to prevent.
 *
 * Problems block the whole upgrade rather than only the agents they name. A missing
 * plugin means the new version's bindings cannot be written, and half a template is
 * worse than none.
 */
export async function applyUpgrade(
  db: Kysely<Schema>,
  manifest: TemplateManifest,
  now = new Date().toISOString(),
): Promise<Change[]> {
  const { changes, problems } = await planUpgrade(db, manifest);
  if (problems.length > 0) {
    throw new Error(
      [`${manifest.name} cannot be upgraded:`, ...problems.map(describeProblem)].join("\n"),
    );
  }

  const agents = new Map(manifest.agents.map((a) => [a.slug, a]));

  await db.transaction().execute(async (trx) => {
    for (const change of changes) {
      if (change.kind === "create") {
        await writeAgent(trx, manifest, agents.get(change.slug)!, now);
        continue;
      }
      if (change.kind !== "update") continue;

      const written = authored(agents.get(change.slug)!);
      if (change.republish) await publishVersion(trx, change.agentId, written, now);

      await trx
        .updateTable("template_installs")
        .set({ installed_version: manifest.version, source_hash: sourceHash(written), installed_at: now })
        .where("template_name", "=", manifest.name)
        .where("agent_id", "=", change.agentId)
        .execute();
    }
  });

  return changes;
}
