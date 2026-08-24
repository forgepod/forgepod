# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository, under Security, then
Report a vulnerability. The report stays private until a fix exists.

If that is unavailable to you, email security@forgepod.dev.

Please do not open a public issue for a vulnerability, and do not test against an
install you do not own.

## What counts as a vulnerability here

The project runs operator-chosen code on purpose, so a few things that look like
findings are the design:

**A plugin running arbitrary code is not a vulnerability.** A plugin is an MCP server
the operator chose and installed, and executing it is the entire point. The container
is the boundary. A way for a plugin to escape that container, or to reach core state
it was never granted, is a vulnerability and we want to hear about it.

**An agent being talked into a tool call is a limitation, not a bug, unless something
was bypassed.** Prompt injection through user input or tool output is unsolved in the
field and this project does not claim to prevent it. What is in scope: a guardrail or
quota that can be bypassed, an agent reaching a tool it was never bound to, and a user
reaching an agent they were never assigned.

Taken seriously without qualification: provider keys or credentials leaking through
logs, run records or the API; authentication and authorization gaps; one user reading
another user's runs; a template or plugin manifest escalating privilege at install
time.

## Supported versions

Nothing is released yet. `main` is the only branch that receives fixes.
