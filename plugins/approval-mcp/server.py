"""
Human approval before a risky tool call.

Three tools, and the split between them is the whole design:

  on_tool_before_call  a FILTER on tool.before_call. Records what the agent wanted and
                       blocks, unless the operator has already approved that exact call.
  list_pending         what is waiting on an answer.
  resolve              the answer: allow once, always allow, or refuse.

A blocked call ends that run, and the operator runs the agent again once they have
approved. The plugin does not hold the call open waiting for a human: an open stdio
connection pins the run and every other plugin it has launched for as long as the person
takes to look, and resuming a stopped run means core persisting its whole loop state,
which is a core decision and not something to smuggle in behind a plugin.

Written against the wire with no third-party dependency. State is SQLite from the
standard library, in the plugin's own state directory.
"""

import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

NAME = "approval-mcp"
VERSION = "0.1.0"
FALLBACK_PROTOCOL = "2025-06-18"

STATE = os.environ.get("FORGEPOD_STATE_DIR", ".")
DB = os.path.join(STATE, "approvals.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  tool TEXT NOT NULL,
  -- Canonical JSON, so the same call made twice matches the approval it was given.
  input TEXT NOT NULL,
  run_id TEXT,
  requested_at TEXT NOT NULL,
  -- pending, approved, always, refused, used
  status TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_open ON approvals (agent, tool, status);
"""

DECISIONS = {"allow_once": "approved", "always": "always", "refuse": "refused"}

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

PENDING = {
    "type": "object",
    "properties": {
        "id": {"type": "integer"},
        "agent": {"type": "string"},
        "tool": {"type": "string"},
        "input": {"type": "object"},
        "requestedAt": {"type": "string"},
    },
    "required": ["id", "agent", "tool", "requestedAt"],
}

TOOLS = [
    {
        "name": "on_tool_before_call",
        "description": "Ask a human before this call runs. Bind to the tool.before_call hook.",
        "inputSchema": PAYLOAD,
        "outputSchema": {
            "type": "object",
            "properties": {"action": {"type": "string"}, "reason": {"type": "string"}},
            "required": ["action"],
        },
    },
    {
        "name": "list_pending",
        "description": "The calls waiting on an answer, newest last.",
        "inputSchema": {
            "type": "object",
            "properties": {"agent": {"type": "string", "description": "Only this agent's slug."}},
        },
        "outputSchema": {
            "type": "object",
            "properties": {"pending": {"type": "array", "items": PENDING}},
            "required": ["pending"],
        },
    },
    {
        "name": "resolve",
        "description": "Answer one pending call: allow_once, always, or refuse.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "integer"},
                "decision": {"type": "string", "enum": list(DECISIONS)},
            },
            "required": ["id", "decision"],
        },
        "outputSchema": {
            "type": "object",
            "properties": {"id": {"type": "integer"}, "status": {"type": "string"}},
            "required": ["id", "status"],
        },
    },
]


# One connection for the life of the process. `with conn` is a transaction, not a close,
# so opening one per call would leak a handle per hook.
CONN = None


def db():
    global CONN
    if CONN is None:
        os.makedirs(STATE, exist_ok=True)
        CONN = sqlite3.connect(DB)
        CONN.row_factory = sqlite3.Row
        CONN.executescript(SCHEMA)
    return CONN


def now():
    return datetime.now(timezone.utc).isoformat()


def canonical(value):
    """Sorted keys and no spaces, so a re-run's arguments match the row they were
    approved as even when the model emits them in another order."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def before_call(arguments):
    agent = arguments.get("agentSlug", "")
    call = arguments.get("call") or {}
    tool = call.get("tool", "")
    payload = canonical(call.get("input"))

    with db() as conn:
        blanket = conn.execute(
            "SELECT id FROM approvals WHERE agent = ? AND tool = ? AND status = 'always'",
            (agent, tool),
        ).fetchone()
        if blanket:
            return {"action": "allow", "reason": "always allowed (approval %d)" % blanket["id"]}

        # An approval is spent when it is used, so approving once allows once. The row
        # stays as the record of what ran and why it was allowed to.
        granted = conn.execute(
            "SELECT id FROM approvals WHERE agent = ? AND tool = ? AND input = ?"
            " AND status = 'approved' ORDER BY id LIMIT 1",
            (agent, tool, payload),
        ).fetchone()
        if granted:
            conn.execute("UPDATE approvals SET status = 'used' WHERE id = ?", (granted["id"],))
            return {"action": "allow", "reason": "approval %d" % granted["id"]}

        # Asking twice for a call already waiting on an answer would give the operator two
        # cards for one question.
        waiting = conn.execute(
            "SELECT id FROM approvals WHERE agent = ? AND tool = ? AND input = ?"
            " AND status = 'pending' ORDER BY id LIMIT 1",
            (agent, tool, payload),
        ).fetchone()
        if waiting:
            return {"action": "block", "reason": "waiting on approval %d" % waiting["id"]}

        cursor = conn.execute(
            "INSERT INTO approvals (agent, tool, input, run_id, requested_at, status)"
            " VALUES (?, ?, ?, ?, ?, 'pending')",
            (agent, tool, payload, arguments.get("runId"), now()),
        )
        return {"action": "block", "reason": "waiting on approval %d" % cursor.lastrowid}


def list_pending(agent=None):
    query = "SELECT id, agent, tool, input, requested_at FROM approvals WHERE status = 'pending'"
    params = ()
    if agent:
        query += " AND agent = ?"
        params = (agent,)

    with db() as conn:
        rows = conn.execute(query + " ORDER BY id", params).fetchall()

    return {
        "pending": [
            {
                "id": row["id"],
                "agent": row["agent"],
                "tool": row["tool"],
                "input": json.loads(row["input"]),
                "requestedAt": row["requested_at"],
            }
            for row in rows
        ]
    }


def resolve(id, decision):
    status = DECISIONS.get(decision)
    if status is None:
        raise ValueError("decision has to be one of " + ", ".join(DECISIONS))

    with db() as conn:
        changed = conn.execute(
            "UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
            (status, now(), id),
        ).rowcount
        if not changed:
            raise ValueError("no approval %s is waiting on an answer" % id)

    return {"id": id, "status": status}


HANDLERS = {
    "on_tool_before_call": lambda args: before_call(args),
    "list_pending": lambda args: list_pending(args.get("agent")),
    "resolve": lambda args: resolve(args.get("id"), args.get("decision", "")),
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
