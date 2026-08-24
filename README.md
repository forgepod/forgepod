# ForgePod

A self-hosted core for building AI agent harnesses. The core carries no domain
logic. You hand it a template describing your agents and a few plugins giving them
capability, and you have a working product for your field.

Early stage. The plugin runtime works and is tested. Everything else is listed at the
bottom as not built.

## Three concepts

**Agent** is the only execution unit: a system prompt, a model, bound tools,
guardrails and a version history. Multi-step behaviour falls out of the tool-calling
loop, so there is no workflow engine to learn.

**Plugin** is an MCP server. ForgePod has no plugin API of its own, so you write a
normal MCP server in whatever language suits the job and it works here and anywhere
else that speaks MCP.

**Template** is a declarative package: agent definitions, prompts, tool bindings, UI
configuration and the plugins it requires. A vertical is a template plus a few
plugins.

## What runs today

`src/plugins/mcp.ts` connects to an MCP server over stdio or HTTP, lists its tools and
calls them. `plugins/beam-mcp` is a sample plugin that carries numpy and scipy, there
to prove a plugin's dependencies never reach the core.

Needs Bun, and Python 3 for the sample plugin.

```sh
bun install
bun run plugin:setup   # a venv for the sample plugin, one time
bun test
```

## Writing a plugin

An MCP server and a `plugin.json` beside it:

```json
{
  "name": "beam-mcp",
  "version": "0.1.0",
  "transport": "stdio",
  "command": ".venv/bin/python",
  "args": ["server.py"],
  "image": "forgepod/beam-mcp:0.1.0"
}
```

With `image` set, the core launches the plugin as `docker run --rm -i <image>`.
Without it, the plugin runs on the host, which is only for developing the plugin
itself. Either way the channel is stdio, so there is no port to allocate and no
network to configure.

Give every tool a typed return. A bare `dict` publishes no output schema, and the core
then gets a JSON string to re-parse instead of validated data:

```python
class Reactions(TypedDict):
    reaction_left_kn: float
    reaction_right_kn: float
    max_moment_knm: float

@mcp.tool()
def beam_reactions(span_m: float, load_kn: float, load_from_left_m: float) -> Reactions:
    ...
```

For a remote plugin, drop `command` and `image` and set `"transport": "http"` with a
`url`. That path is written but has never been executed.

## Not built yet

Admin UI, agent storage and versioning, run execution and history, usage recording,
template installation. The container launch is assembled and unit tested, but no
container has actually been started, since Docker was absent from the machine the
plugin runtime was written on.

## License

Apache-2.0. See [LICENSE](LICENSE).
