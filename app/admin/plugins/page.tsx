import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { installedPlugins, inspect, type Inspection } from "@/plugins/registry";
import { formatParams, formatReturn, type Schema } from "@/plugins/signature";

export const dynamic = "force-dynamic";
export const metadata = { title: "Plugins" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default async function PluginsPage() {
  const plugins = await Promise.all((await installedPlugins()).map(inspect));
  const tools = plugins.reduce((n, p) => n + (p.tools?.length ?? 0), 0);
  const silent = plugins.filter((p) => !p.tools).length;

  return (
    <main className="sheet">
      <header className="masthead">
        <span className="wordmark">ForgePod</span>
        <span className="crumb">admin / plugins</span>
      </header>

      <div className="summary">
        <h1>Capabilities</h1>
        <p className="tally">
          {plural(plugins.length, "plugin")}, {plural(tools, "tool")} reachable
          {silent > 0 ? `, ${silent} not answering` : ""}
        </p>
      </div>

      <p className="note">
        {plugins.length === 0
          ? "Nothing installed yet. Put a directory holding a plugin.json into plugins/ and reload."
          : "Every signature below was read from the plugin itself when this page loaded."}
      </p>

      {plugins.map((plugin) => (
        <PluginEntry key={plugin.dir} plugin={plugin} />
      ))}
    </main>
  );
}

function PluginEntry({ plugin }: { plugin: Inspection }) {
  const name = plugin.manifest?.name ?? plugin.dir;
  const up = Boolean(plugin.tools);

  return (
    <section className="plugin">
      <div className="plugin-head">
        <h2>
          {name}{" "}
          {plugin.manifest ? <span className="version">{plugin.manifest.version}</span> : null}
        </h2>
        <span className={`state ${up ? "state-up" : "state-down"}`}>
          {up ? `answered in ${plugin.ms}ms` : "no answer"}
        </span>
      </div>

      {plugin.manifest?.description ? <p className="desc">{plugin.manifest.description}</p> : null}

      <dl className="meta">
        <dt>source</dt>
        <dd>{plugin.dir}</dd>
        {plugin.launch ? (
          <>
            <dt>launch</dt>
            <dd>{plugin.launch}</dd>
          </>
        ) : null}
      </dl>

      {plugin.error ? (
        <div className="failure">
          <p>{plugin.error}</p>
          <p>Run the launch command above on its own to see what it prints.</p>
        </div>
      ) : (
        <div className="tools">
          {plugin.tools?.map((tool) => (
            <ToolSignature key={tool.name} tool={tool} />
          ))}
        </div>
      )}
    </section>
  );
}

function ToolSignature({ tool }: { tool: Tool }) {
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
