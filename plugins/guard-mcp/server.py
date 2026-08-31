"""
The guardrail plugin: a limit an operator writes down is a limit the run obeys.

Three handlers, bound to three hook points:

  on_tool_before_call        a FILTER on tool.before_call. Blocks a forbidden tool and
                             an oversized input before the call happens.
  on_tool_after_call         an ACTION on tool.after_call. Counts consecutive failures
                             of the same tool for this run.
  on_before_provider_call    a FILTER on run.before_provider_call. Blocks, which ends
                             the run, once a tool has failed too many times in a row.

The split is what makes the failure rule possible at all: one hook call sees one moment,
but a plugin keeps its own state, so the count lives here rather than in core.

Rules are a file this plugin reads, never core schema, because which calls are risky is
a question only the operator can answer. See rules.example.json.

Written against the wire with no third-party dependency, so it runs the same on a host
and in the container.
"""

import fnmatch
import json
import os
import sys

NAME = "guard-mcp"
VERSION = "0.1.0"
FALLBACK_PROTOCOL = "2025-06-18"

STATE = os.environ.get("FORGEPOD_STATE_DIR", ".")
RULES = os.path.join(STATE, "rules.json")

# runId -> {"tool": name, "count": n}. A plugin process serves one run today, so this
# never has to be pruned.
# ponytail: in memory, per process. Persist it to STATE if a process ever outlives a run.
FAILURES = {}

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

VERDICT = {
    "type": "object",
    "properties": {"action": {"type": "string"}, "reason": {"type": "string"}},
    "required": ["action"],
}

TOOLS = [
    {
        "name": "on_tool_before_call",
        "description": "Refuse a forbidden tool or an oversized input. Bind to tool.before_call.",
        "inputSchema": PAYLOAD,
        "outputSchema": VERDICT,
    },
    {
        "name": "on_tool_after_call",
        "description": "Count consecutive failures of one tool. Bind to tool.after_call.",
        "inputSchema": PAYLOAD,
        "outputSchema": {
            "type": "object",
            "properties": {"tool": {"type": "string"}, "consecutiveFailures": {"type": "integer"}},
            "required": ["consecutiveFailures"],
        },
    },
    {
        "name": "on_before_provider_call",
        "description": "End a run that is looping on a failing tool. Bind to run.before_provider_call.",
        "inputSchema": PAYLOAD,
        "outputSchema": VERDICT,
    },
]


def rules():
    """No rules file means nothing was forbidden. A broken one raises, and core reads a
    handler that failed as a block, which is the only safe reading of a guard that
    cannot say what it guards."""
    if not os.path.exists(RULES):
        return []
    with open(RULES, encoding="utf-8") as handle:
        loaded = json.load(handle).get("rules", [])
    if not isinstance(loaded, list):
        raise ValueError(RULES + ": rules has to be a list")
    return loaded


def matching(tool):
    # fnmatchcase, not fnmatch: fnmatch normalises case per platform, and a rule that
    # stops matching because the host is Windows is a guardrail that silently opened.
    for rule in rules():
        if fnmatch.fnmatchcase(tool, rule.get("tool", "*")):
            yield rule


def before_call(arguments):
    call = arguments.get("call") or {}
    tool = call.get("tool", "")
    size = len(json.dumps(call.get("input"), ensure_ascii=False).encode("utf-8"))

    for rule in matching(tool):
        if rule.get("block"):
            return {"action": "block", "reason": tool + " is not allowed here: " + rule["block"]}

        ceiling = rule.get("maxInputBytes")
        if ceiling is not None and size > ceiling:
            return {
                "action": "block",
                "reason": "%s was called with %d bytes of input, over the %d byte limit"
                % (tool, size, ceiling),
            }

    return {"action": "allow"}


def after_call(arguments):
    run_id = arguments.get("runId", "")
    call = arguments.get("call") or {}
    tool = call.get("tool", "")
    failed = bool((arguments.get("result") or {}).get("isError"))

    if not failed:
        FAILURES.pop(run_id, None)
        return {"tool": tool, "consecutiveFailures": 0}

    seen = FAILURES.get(run_id)
    count = seen["count"] + 1 if seen and seen["tool"] == tool else 1
    FAILURES[run_id] = {"tool": tool, "count": count}
    return {"tool": tool, "consecutiveFailures": count}


def before_provider_call(arguments):
    seen = FAILURES.get(arguments.get("runId", ""))
    if not seen:
        return {"action": "allow"}

    for rule in matching(seen["tool"]):
        ceiling = rule.get("maxConsecutiveFailures")
        if ceiling is not None and seen["count"] >= ceiling:
            return {
                "action": "block",
                "reason": "%s failed %d times in a row, so the run stops rather than loops"
                % (seen["tool"], seen["count"]),
            }

    return {"action": "allow"}


HANDLERS = {
    "on_tool_before_call": before_call,
    "on_tool_after_call": after_call,
    "on_before_provider_call": before_provider_call,
}


def call_tool(params):
    name = params.get("name", "")
    arguments = params.get("arguments") or {}

    try:
        handler = HANDLERS.get(name)
        if handler is None:
            raise ValueError("no such tool: " + name)
        structured = handler(arguments)
    except Exception as failure:  # noqa: BLE001 - reported to the caller, not swallowed
        return {"content": [{"type": "text", "text": str(failure)}], "isError": True}

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
