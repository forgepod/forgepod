"""What an agent has been told, kept between runs.

The first ForgePod plugin that stores anything, and the first consumer of the
identity the core injects. Every row is scoped to FORGEPOD_AGENT_SLUG: the slug
is authored in a template and is the same on every install of it, while the agent
and run ids are regenerated per install and per run, so the slug is the only key
that survives a reinstall.

Retrieval is SQLite's own FTS5 and nothing else. No embeddings, no vector store,
no model to download. Those can replace the index behind these same three tools
later, which is the reason not to choose one yet.
"""

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import TypedDict

from mcp.server.mcpserver import MCPServer

mcp = MCPServer(
    name="memory-mcp",
    version="0.1.0",
    instructions=(
        "Remember what the person tells you about themselves, their preferences and their "
        "ongoing work, and recall it before answering a question that depends on it."
    ),
)

# The core sets this. The fallback is for running the server by hand while developing it,
# and puts the file exactly where the core would have mounted it.
STATE = Path(os.environ.get("FORGEPOD_STATE_DIR") or Path(__file__).parent / "state")

# A scan lists tools without running an agent, so there is no slug then. Anything written
# under this name came from outside a run, which is a bug worth being able to see.
AGENT = os.environ.get("FORGEPOD_AGENT_SLUG") or "unscoped"


class Remembered(TypedDict):
    id: int


class Memory(TypedDict):
    id: int
    text: str
    remembered_at: str


class Recalled(TypedDict):
    memories: list[Memory]


class Forgotten(TypedDict):
    forgotten: bool


def db() -> sqlite3.Connection:
    """One connection per call, so the server holds no lock between tool calls."""
    STATE.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(STATE / "memory.db")
    # One FTS5 table rather than a table plus an external-content index, because the
    # index then needs triggers to stay in step and there is nothing here to gain by it.
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memories "
        "USING fts5(agent UNINDEXED, text, remembered_at UNINDEXED)"
    )
    return conn


def match_query(query: str) -> str:
    """Every word as a quoted term, joined by OR.

    Quoted, because an apostrophe or a bare `-` in something a person said is FTS5 syntax
    and the query fails. The cost is that FTS operators are not available to the caller.

    OR rather than the default AND, because a recall arrives as a question rather than as
    search terms. "what span do I usually use" shares one word with "Standard beam span is
    6 m", and requiring all of them returns nothing every time. Ranking, not the filter,
    is what puts the best row first.
    """
    return " OR ".join('"' + word.replace('"', '""') + '"' for word in query.split())


@mcp.tool()
def remember(text: str) -> Remembered:
    """Store one thing worth recalling in a later conversation. One fact per call."""
    if not text.strip():
        raise ValueError("text must not be empty")

    with db() as conn:
        cursor = conn.execute(
            "INSERT INTO memories (agent, text, remembered_at) VALUES (?, ?, ?)",
            (AGENT, text.strip(), datetime.now(timezone.utc).isoformat()),
        )
        return {"id": int(cursor.lastrowid or 0)}


@mcp.tool()
def recall(query: str = "", limit: int = 5) -> Recalled:
    """Find what was remembered earlier. An empty query returns the most recent instead."""
    limit = max(1, min(limit, 50))

    with db() as conn:
        if query.strip():
            rows = conn.execute(
                "SELECT rowid, text, remembered_at FROM memories "
                "WHERE memories MATCH ? AND agent = ? ORDER BY rank LIMIT ?",
                (match_query(query), AGENT, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT rowid, text, remembered_at FROM memories "
                "WHERE agent = ? ORDER BY rowid DESC LIMIT ?",
                (AGENT, limit),
            ).fetchall()

    return {
        "memories": [
            {"id": int(row[0]), "text": row[1], "remembered_at": row[2]} for row in rows
        ]
    }


@mcp.tool()
def forget(id: int) -> Forgotten:
    """Delete one memory by the id that remember returned or recall reported."""
    with db() as conn:
        # The agent filter is the scope check: one agent cannot delete another's row by
        # guessing an id.
        cursor = conn.execute("DELETE FROM memories WHERE rowid = ? AND agent = ?", (id, AGENT))
        return {"forgotten": cursor.rowcount > 0}


if __name__ == "__main__":
    mcp.run(transport="stdio")
