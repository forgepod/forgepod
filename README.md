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

**Template** is a directory holding a `template.json`: the agents it creates, their
prompts, their tool bindings, and the plugins it requires. A vertical is a template plus
a few plugins.

Installing one from `/admin/templates` writes those agents and then forgets the template
existed, so what you have afterwards are ordinary agents you edit and delete like any
other. That is also why there is no upgrade path: a changed template installs as new
agents, or is applied by hand.

Three ship in `templates/`. `structural-beam` binds both tools of the sample beam
plugin. `legal-drafting` and `code-review` bind none at all, which is the split that
matters: a core that quietly assumes an agent has tools fails on the second and third.

An agent's prompt is written either as one `systemPrompt`, or as the named sections
`persona`, `instructions`, `guardrails` and `outputFormat`. Sections are joined in that
order at install, with a blank line between the ones present and nothing added around
them. An agent gives one shape or the other, and giving both is rejected. `legal-drafting`
is written in sections, `code-review` as a single prompt.

## What runs today

`src/plugins/mcp.ts` connects to an MCP server over stdio or HTTP, lists its tools and
calls them. Six plugins ship. `plugins/beam-mcp` carries numpy and scipy, there to prove
a plugin's dependencies never reach the core. `plugins/memory-mcp` keeps what an agent was
told, in SQLite with FTS5 and no embeddings, scoped to the install and the agent's slug: it
is what proves a plugin can hold state and see who is calling it. `plugins/audit-mcp` is the reference hook handler, in Python with no
dependency at all. `plugins/guard-mcp` is the guardrail: it refuses the tool calls an
operator listed as forbidden and ends a run that keeps calling a tool that fails.
`plugins/approval-mcp` holds a risky call until a human answers it. `plugins/csv-mcp` is PHP
with no MCP library at all, answering JSON-RPC by hand, which is what proves the core has
no plugin API of its own to conform to.

The admin has one page. Scanning starts every plugin under `plugins/` that holds a
`plugin.json` and records the tools each one publishes. The page renders that last
reading as typed signatures, with the launch command used and how long the round trip
took. Scanning happens when you ask, since starting every plugin is slow and has side
effects.

Needs Bun, and Python 3 for two of the plugins that ship. The third is PHP and runs only
in a container. A container runtime is optional and
only the container test needs it.

```sh
cp .env.example .env   # every setting the server reads, with what each one does
bun install
bun run plugin:setup   # a venv per plugin, one time
bun run plugin:image   # build each plugin's image, one time
bun test
bun run dev            # admin at http://localhost:3000/admin/plugins
```

The container test skips itself with a message if the image is not built. Set
`FORGEPOD_CONTAINER_RUNTIME=podman` if that is what you have; the default is `docker`
and anything with a compatible `run` command works.

## Writing a plugin

An MCP server and a `plugin.json` beside it. Use your language's MCP library if it has
one, or answer the protocol directly: it is JSON-RPC 2.0 over stdin and stdout, one object
per line, with four messages that matter. `plugins/csv-mcp` does it that way in about 270
lines of dependency-free PHP if you want to see the whole of it.

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

A run also tells the plugin who is calling: `FORGEPOD_INSTALL_ID`, `FORGEPOD_AGENT_SLUG`,
`FORGEPOD_AGENT_ID` and `FORGEPOD_RUN_ID`, widest to narrowest. A plugin that keeps state
keys on the install and the slug together. The slug is authored in the template and
survives a reinstall where the agent id does not, but it is the same string on every
install of that template, so the install has to be part of the key before two of them
share one plugin. The core sets these after the manifest's own `env`, so a plugin cannot
name itself a different agent.

The install id is generated once and kept in the database, so it identifies the install
rather than the machine. `FORGEPOD_INSTALL_ID` overrides it, which is how a host that
already knows who its tenants are names them itself.

A plugin that keeps something between runs declares `"state": true`. Core sets
`FORGEPOD_STATE_DIR` to a directory that outlives the run and the plugin opens that path,
never learning whether it was a mount. In a container it is `/state`, mounted from a
`state/` directory beside the plugin on the host. Running on the host it is that same
directory directly. Without the flag a container starts empty every run, since it is
launched with `--rm` and closed when the run ends.

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

## Hooks

A run has five points a plugin can be called at. This is what makes the core extensible
without a plugin API: a hook handler is an ordinary MCP tool, so anything that can be a
plugin can already be a hook.

| hook | kind | what it is for |
| --- | --- | --- |
| `run.before` | action | a run is starting |
| `tool.after_call` | action | a tool answered |
| `run.after` | action | the run is finished and its row is final |
| `run.error` | action | the run failed |
| `tool.before_call` | filter | decide whether a tool call runs, and with what input |
| `run.before_provider_call` | filter | rewrite the system prompt for this turn |

An action is told what happened and cannot change it. A handler that fails is recorded
against the run as a note, and the run continues. `run.after` and `run.error` also carry
`blockedCalls`, every call a filter refused and why, because a plugin sees only what it
refused itself and by then there is more than one filter in a run.

A filter is asked, and its answer decides what happens next. It replies with one object:

```jsonc
{ "action": "allow" }
{ "action": "block", "reason": "waiting on an approval" }
{ "action": "modify", "value": { "amount": 500 } }   // value replaces what was filtered
```

Anything else, a crash included, blocks. A guardrail that cannot answer has not allowed
anything. Handlers run in priority order, lowest first, and each one is asked about what
the previous returned, so a redaction filter and an approval filter compose without
knowing about each other.

That is the whole mechanism. Approval before a risky call, an audit trail, PII redaction
and per-tool policy are plugins bound to these points, not core features, because which
calls are risky is a question only a domain can answer.

Because a filter sits in front of every tool call an agent makes, a plugin has to be
marked trusted on `/admin/plugins` before it can bind to one. Actions are open to any
plugin. Trust is granted by whoever runs the install and never by the plugin.

Bind and unbind on the agent's page. A binding belongs to the agent rather than to its
version, so publishing a new version never drops a guardrail. `plugins/audit-mcp` is the
reference: two handlers, one of each kind, in a file with no dependencies.

`plugins/guard-mcp` is what a written limit looks like once it is enforced. Its rules are
a JSON file in the plugin's own state directory rather than core schema, because which
calls are risky is a question only the operator can answer. A forbidden tool and an
oversized input are refused at `tool.before_call`, and a tool that fails the same way
several turns running ends the run at `run.before_provider_call`, which is a count only a
plugin with its own state can keep. Copy `plugins/guard-mcp/rules.example.json` to
`state/rules.json` to configure it.

`plugins/approval-mcp` is the same hook with a person on the other end. A call it has no
answer for is recorded and blocked, which ends that run, and `list_pending` and `resolve`
are how an operator answers. Approving allows the call on the next run rather than
resuming the one that stopped: holding the connection open would pin the run and every
plugin it has launched for as long as the person takes to look, and resuming a stopped
run means core persisting its whole loop state, which is a separate decision.

The agent's page shows what is being held as a card in the run, in the place the call
would have taken, with refuse and allow and always allow on it. Core finds the plugin by
the pair of tools it publishes, `list_pending` and `resolve`, so it never learns a
plugin's name; a plugin publishing that pair is asking to be answered from the admin.
That is the only route from a page to a plugin's tool, and everything else a plugin
publishes stays reachable only from inside a run.

An agent is a system prompt, a model and the tools it may call. The editor at
`/admin/agents` binds tools by their published signature, and saving publishes a new
version, so a run always records the exact configuration it executed. The same page
runs the agent and streams what happens: text as it is written, then the tool it
reached for, the arguments it passed, and what came back. When the run finishes the
stored transcript takes over, so the live view is a preview and the record is what was
written to the database as it went. Closing the tab loses the preview and nothing
else.

## Models

Two ways to answer, chosen by one switch. Both stream.

Leave `FORGEPOD_BASE_URL` unset and the install talks to Anthropic directly with
`ANTHROPIC_API_KEY`. Set it to an OpenAI-compatible gateway and the install talks to
that instead, with `FORGEPOD_API_KEY`:

```sh
FORGEPOD_BASE_URL=https://opencode.ai/zen/v1
FORGEPOD_API_KEY=...
```

Keys are never written to the database. They belong to whoever runs the install.

`FORGEPOD_DEFAULT_MODEL` is what an agent gets when neither its template nor the operator
named one. It defaults to `claude-opus-5`, which is right talking to Anthropic and wrong
on a gateway that serves no Anthropic ids: without it, installing a template there
produces agents that all fail on their first run naming a model the gateway never had.

The seam is `src/agents/provider.ts` and it stays thin on purpose: the agent loop never
learns a provider's message format, and a provider never learns what a run is. An
assistant turn travels back to its own provider untouched, which is what keeps a model's
internal continuity intact.

## Database

SQLite by default, in `forgepod.db`, with no database server to install. Point
`FORGEPOD_DATABASE_URL` at a `postgres://` URL to use Postgres instead.

That default path is relative to the working directory, so a deployment should set
`FORGEPOD_DATABASE_URL` explicitly. The production server starts from
`.next/standalone`, and without the variable it creates an empty database there rather
than finding the one you have been developing against.

One schema and one set of queries serve both, and that only holds because nothing here
uses dialect-specific SQL. JSON is stored as text rather than jsonb, timestamps are ISO
strings, and every column is text or integer. `src/db/portability.test.ts` runs the same
migration and round trip against SQLite and against real Postgres and fails if the two
disagree, so the claim is checked rather than asserted.

Vector search is the feature that would break this first. That is why it belongs in a
plugin carrying its own store.

## Layout

`src/` is the product and imports no web framework. The Next app under `app/` is a
delivery shell over it. `src/boundary.test.ts` enforces that, so the shell stays
replaceable rather than load-bearing.

One file is allowed to be runtime specific, `src/db/bun-sqlite.ts`, and the test names
it explicitly. No SQLite binding works on both runtimes today: better-sqlite3 crashes
Bun 1.3.14 and node:sqlite is unsupported there. That is why the app runs under Bun,
which is what `bun --bun next start` in the scripts is for.

## Not built yet

Agent assignment, quotas, and everything billing. Guardrails have a mechanism now, the
filter hooks above, but no policy plugin ships: the only handler in the tree is the audit
one, which watches and allows. A template carries no UI
configuration, and declares no storage of its own: a vertical that needs either owns it
in a plugin.
Version history is recorded but there is no way to view or roll back to an old version
yet.

The provider adapters are covered by tests that stub their HTTP, so the request and
response mapping is checked in both directions, but no request has been made to a live
provider from this repository.

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
