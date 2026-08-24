import { database } from "@/db";
import { formatParams, formatReturn, type Schema } from "@/plugins/signature";
import { loadPlugins, type StoredPlugin, type StoredTool } from "@/plugins/store";
import { Masthead } from "../../masthead";
import { PageHeader } from "../../page-header";
import { rescan } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Plugins" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.round(hours / 24), "day")} ago`;
}

export default async function PluginsPage() {
  const plugins = await loadPlugins(await database());
  const tools = plugins.reduce((n, p) => n + p.tools.length, 0);
  const silent = plugins.filter((p) => p.error).length;
  const scannedAt = plugins[0]?.scannedAt;

  return (
    <main className="sheet">
      <Masthead here="plugins" />

      <div className="summary">
        <h1>Capabilities</h1>
        <form action={rescan}>
          <button type="submit" className="action">
            {scannedAt ? "Scan again" : "Scan plugins"}
          </button>
        </form>
      </div>

      <p className="tally">
        {scannedAt
          ? `${plural(plugins.length, "plugin")}, ${plural(tools, "tool")}${silent > 0 ? `, ${silent} not answering` : ""}, scanned ${ago(scannedAt)}`
          : "Not scanned yet"}
      </p>

      <p className="note">
        {scannedAt
          ? "Scanning starts every plugin and reads what it publishes. What you see below is that last reading, not a live one."
          : "Put a directory holding a plugin.json into plugins/, then scan. Each plugin is started once and asked what it can do."}
      </p>

      {plugins.map((plugin) => (
        <PluginEntry key={plugin.name} plugin={plugin} />
      ))}
    </main>
  );
}

function PluginEntry({ plugin }: { plugin: StoredPlugin }) {
  const up = !plugin.error;

  return (
    <section className="plugin">
      <div className="plugin-head">
        <h2>
          {plugin.name} <span className="version">{plugin.version}</span>
        </h2>
        <span className={`state ${up ? "state-up" : "state-down"}`}>
          {up ? `answered in ${plugin.roundTripMs}ms` : "no answer"}
        </span>
      </div>

      {plugin.description ? <p className="desc">{plugin.description}</p> : null}

      <dl className="meta">
        <dt>source</dt>
        <dd>{plugin.sourceDir}</dd>
        <dt>launch</dt>
        <dd>{plugin.launch}</dd>
      </dl>

      {plugin.error ? (
        <div className="failure">
          <p>{plugin.error}</p>
          <p>Run the launch command above on its own to see what it prints.</p>
        </div>
      ) : (
        <div className="tools">
          {plugin.tools.map((tool) => (
            <ToolSignature key={tool.name} tool={tool} />
          ))}
        </div>
      )}
    </section>
  );
}

function ToolSignature({ tool }: { tool: StoredTool }) {
  const params = formatParams(tool.inputSchema as Schema);
  const returns = formatReturn(tool.outputSchema as Schema | undefined);
  // An untyped return is coloured like a fault, because for a caller it is one.
  const untyped = !tool.outputSchema;

  return (
    <article className="tool">
      <h3>{tool.name}</h3>
      <pre className="sig">
        <code>
          ({params})
          {"\n→ "}
          <span className={untyped ? "untyped" : "ret"}>{returns}</span>
        </code>
      </pre>
      {tool.description ? <p className="tool-desc">{tool.description}</p> : null}
    </article>
  );
}
