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

The admin has one page. It reads every directory under `plugins/` that holds a
`plugin.json`, starts each plugin, and renders the tools it published as typed
signatures, alongside the launch command used and how long the round trip took.

Needs Bun, and Python 3 for the sample plugin. A container runtime is optional and
only the container test needs it.

```sh
bun install
bun run plugin:setup   # a venv for the sample plugin, one time
bun run plugin:image   # build the sample plugin's image, one time
bun test
bun run dev            # admin at http://localhost:3000/admin/plugins
```

The container test skips itself with a message if the image is not built. Set
`FORGEPOD_CONTAINER_RUNTIME=podman` if that is what you have; the default is `docker`
and anything with a compatible `run` command works.

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

With `image` set, the core launches the plugin as `<runtime> run --rm -i <image>`.
Without it, the plugin runs on the host, which is only for developing the plugin
itself. Either way the channel is stdio, so there is no port to allocate and no
network to configure.

Plugin environment variables are passed by name, never by value. The value reaches the
container through the process environment, so a secret never appears in an argv that
other processes can read.

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
`url`.

## Layout

`src/` is the product and imports no web framework and no runtime-specific global. The
Next app under `app/` is a delivery shell over it. `src/boundary.test.ts` enforces that,
so the shell stays replaceable rather than load-bearing.

## Not built yet

Everything in the admin past the plugins page, agent storage and versioning, run
execution and history, usage recording, template installation.

The HTTP transport for remote plugins is written but has never been executed. The
container path has: the sample plugin has been discovered and called both on the host
and inside a real container, with identical results.

## License

AGPL-3.0. See [LICENSE](LICENSE).

Copyright 2026 ForgePod contributors. Modifying the core and offering it to others
over a network obliges you to offer them your modified source. Plugins and templates
are separate works and are not affected, since a plugin runs as its own process.

[Contributing](CONTRIBUTING.md), [code of conduct](CODE_OF_CONDUCT.md),
[security policy](SECURITY.md).
