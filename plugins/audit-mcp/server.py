"""
An audit trail for hooks, and the reference for what a hook handler answers.

A hook handler is an ordinary MCP tool. Core calls it at a point in a run and hands it
one JSON object, so a plugin that already speaks MCP needs nothing new to become one.

Two handlers ship here because the two kinds of hook answer differently:

  on_run_after         an ACTION. Core ignores what it returns, and a failure here is
                       recorded against the run without stopping it.
  on_tool_before_call  a FILTER. What it returns decides whether the tool call runs:
                       {"action": "allow"} | {"action": "block", "reason": "..."} |
                       {"action": "modify", "value": {...}} where value replaces the
                       tool's input. Anything else, including a crash, blocks the call.

Written against the wire rather than an SDK, with no third-party dependency, so it runs
the same on a host and in the container.
"""

import json
import os
import sys
from datetime import datetime, timezone

NAME = "audit-mcp"
VERSION = "0.1.0"
FALLBACK_PROTOCOL = "2025-06-18"

# Set by core. A container gets /state mounted here, a host launch gets a directory
# inside the plugin, and this file never learns which one it was given.
STATE = os.environ.get("FORGEPOD_STATE_DIR", ".")

# Every run of every agent lands in one file, deliberately. An audit trail split per
# agent is one an operator has to know the shape of before they can read it.
LOG = os.path.join(STATE, "audit.jsonl")

PAYLOAD = {
    "type": "object",
    "description": "The hook payload core sends. Passed through as it arrives.",
    "properties": {
        "hook": {"type": "string"},
        "runId": {"type": "string"},
        "agentSlug": {"type": "string"},
    },
    "additionalProperties": True,
}

TOOLS = [
    {
        "name": "on_run_after",
        "description": "Append a finished run to the audit log. Bind to the run.after hook.",
        "inputSchema": PAYLOAD,
        "outputSchema": {
            "type": "object",
            "properties": {"written": {"type": "boolean"}, "log": {"type": "string"}},
            "required": ["written", "log"],
        },
    },
    {
        "name": "on_tool_before_call",
        "description": "Record a tool call and allow it. Bind to the tool.before_call hook.",
        "inputSchema": PAYLOAD,
        "outputSchema": {
            "type": "object",
            "properties": {"action": {"type": "string"}, "reason": {"type": "string"}},
            "required": ["action"],
        },
    },
]


def append(payload):
    os.makedirs(STATE, exist_ok=True)
    line = dict(payload)
    line["recordedAt"] = datetime.now(timezone.utc).isoformat()
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(line, ensure_ascii=False) + "\n")


def call_tool(params):
    name = params.get("name", "")
    arguments = params.get("arguments") or {}

    try:
        if name == "on_run_after":
            append(arguments)
            structured = {"written": True, "log": LOG}
        elif name == "on_tool_before_call":
            append(arguments)
            # This plugin watches, it does not judge. A guardrail that decides what to
            # refuse is a different plugin, and it answers in exactly this shape.
            structured = {"action": "allow"}
        else:
            raise ValueError("no such tool: " + name)
    except Exception as failure:  # noqa: BLE001 - reported to the caller, not swallowed
        return {
            "content": [{"type": "text", "text": str(failure)}],
            "isError": True,
        }

    return {
        "content": [{"type": "text", "text": json.dumps(structured)}],
        "structuredContent": structured,
        "isError": False,
    }


def handle(message):
    method = message.get("method", "")
    params = message.get("params") or {}

    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion", FALLBACK_PROTOCOL),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": NAME, "version": VERSION},
        }
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        return call_tool(params)
    if method == "ping":
        return {}
    return None


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue

        # A message with no id is a notification, and answering one is a protocol error.
        request_id = message.get("id")
        if request_id is None:
            continue

        result = handle(message)
        reply = (
            {"jsonrpc": "2.0", "id": request_id, "result": result}
            if result is not None
            else {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": "method not found: " + message.get("method", "")},
            }
        )
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
