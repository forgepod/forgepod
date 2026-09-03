/**
 * `bun run template diff <name>` and `bun run template upgrade <name>`.
 *
 * There is no `forgepod` binary to hang these off yet (#35), and neither belongs in the
 * admin: an upgrade that runs from a web button is one an operator can press by accident,
 * and the whole design of this path is that nothing happens without being asked twice.
 */
import { openDatabase } from "../src/db";
import { availableTemplates, templateRoot } from "../src/templates/registry";
import { applyUpgrade, describeChange, planUpgrade } from "../src/templates/upgrade";

const [command, name] = process.argv.slice(2);

if (command !== "diff" && command !== "upgrade") {
  console.error("usage: bun run template <diff|upgrade> <template-name>");
  process.exit(2);
}
if (!name) {
  console.error(`usage: bun run template ${command} <template-name>`);
  process.exit(2);
}

const found = (await availableTemplates()).find((t) => t.manifest?.name === name);
if (!found?.manifest) {
  console.error(`no template named ${name} under ${templateRoot()}`);
  process.exit(1);
}

const manifest = found.manifest;
const db = await openDatabase();

try {
  const changes =
    command === "diff" ? (await planUpgrade(db, manifest)).changes : await applyUpgrade(db, manifest);

  console.log(`${manifest.name} ${manifest.version} (${command})`);
  for (const change of changes) console.log(`  ${describeChange(change, manifest.version)}`);

  // An upgrade that touched nothing and an upgrade that was refused look the same in a
  // list of lines, so say which happened.
  const edited = changes.filter((c) => c.kind === "edited").length;
  if (edited > 0) console.log(`\n${edited} agent(s) left alone because they were edited since install.`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
} finally {
  await db.destroy();
}
