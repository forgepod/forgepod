# Contributing

The project is early, so the most useful contributions are not core changes.

For anything larger than a fix, open an issue first. It is cheaper to disagree about
where a change belongs before it is written.

## Where your change belongs

Three places, and picking the right one is most of the work.

**A plugin**, if you are adding a capability: a calculation, a data source, an
integration. Plugins are MCP servers and live in their own repositories, so nothing
about them needs to land here.

**A template**, if you are packaging a whole vertical: agents, prompts, tool bindings
and the plugins they need, as declarative files.

**Core**, only if every template needs it. Anything one template needs belongs in a
plugin or a template, and a pull request adding domain logic to core will be turned
down however good the code is.

Two consequences of that, worth knowing before you write anything:

Core carries no dialect-specific SQL. One schema has to run on both SQLite and
Postgres, which is what keeps the first install free of a database server. Vector
search is the usual casualty and belongs in a plugin that brings its own store.

Core carries no Docker client. Launching a plugin in a container is a rewrite of its
command and nothing else, because stdio makes the container's own streams the channel.

## Setup

Needs Bun, and Python 3 for the sample plugin. A container runtime is optional.

```sh
bun install
bun run plugin:setup
bun run plugin:image   # skip this and the container test skips itself
bun test
```

Set `FORGEPOD_CONTAINER_RUNTIME=podman` if that is what you have. The default is
`docker`.

## Before you open a pull request

```sh
bun test
bunx tsc --noEmit
```

Paste the output that matters. Say what you checked rather than that you were
thorough, and keep the body short: what broke, what changed, how you know it works.

Non-trivial logic ships with one runnable check. Not a suite. One test that fails if
the logic breaks.

## Writing a plugin

The README covers the shape. Two rules catch most people:

Give every tool a typed return. A bare dict publishes no output schema, and the core
then receives a string to re-parse instead of validated data.

Ship an image, tagged `forgepod/<name>:<version>`. Running on the host is for
developing a plugin, not for distributing one.

## Sign your commits

Use `git commit -s`, which appends a `Signed-off-by` line certifying that you wrote
the change or have the right to submit it, under the
[Developer Certificate of Origin](https://developercertificate.org/).

## Sign the CLA, for this repository only

A first pull request here gets a bot comment linking to [CLA.md](CLA.md). Signing is
one comment, once per person, and it covers everything you send afterwards.

It exists so the project can distribute contributions under terms other than AGPL-3.0,
which is what a commercial licence needs. CLA.md says so in its own words rather than
leaving it implied.

**Plugins and templates need none of this.** They live in their own repositories under
their own licenses, and nothing in this repository reaches them. If you are building a
plugin or a template, you are done reading.
