"""What an agent has been told, kept between runs.

The first ForgePod plugin that stores anything, and the first consumer of the
identity the core injects. Every row is scoped to the install and the agent's slug
together. The slug is authored in a template and survives a reinstall, where the
agent and run ids do not, but on its own it is the same string on every install of
that template, so the install has to be part of the key before two of them ever
share one plugin.

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
INSTALL = os.environ.get("FORGEPOD_INSTALL_ID") or "unscoped"


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
        "USING fts5(install UNINDEXED, agent UNINDEXED, text, remembered_at UNINDEXED)"
    )

    # A file written before installs were part of the key has no install column, and FTS5
    # has no ALTER. Rebuilding assigns those rows to this install, which is where they
    # came from: nothing else could have written them. Ids change, and callers holding one
    # from an earlier run lose it.
    columns = {row[1] for row in conn.execute("PRAGMA table_info(memories)")}
    if "install" not in columns:
        old = conn.execute("SELECT agent, text, remembered_at FROM memories").fetchall()
        conn.execute("DROP TABLE memories")
        conn.execute(
            "CREATE VIRTUAL TABLE memories "
            "USING fts5(install UNINDEXED, agent UNINDEXED, text, remembered_at UNINDEXED)"
        )
        conn.executemany(
            "INSERT INTO memories (install, agent, text, remembered_at) VALUES (?, ?, ?, ?)",
            [(INSTALL, *row) for row in old],
        )
        conn.commit()

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
            "INSERT INTO memories (install, agent, text, remembered_at) VALUES (?, ?, ?, ?)",
            (INSTALL, AGENT, text.strip(), datetime.now(timezone.utc).isoformat()),
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
                "WHERE memories MATCH ? AND install = ? AND agent = ? ORDER BY rank LIMIT ?",
                (match_query(query), INSTALL, AGENT, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT rowid, text, remembered_at FROM memories "
                "WHERE install = ? AND agent = ? ORDER BY rowid DESC LIMIT ?",
                (INSTALL, AGENT, limit),
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
        # The scope filter is the authorisation check: neither another agent nor another
        # install can delete a row by guessing an id.
        cursor = conn.execute(
            "DELETE FROM memories WHERE rowid = ? AND install = ? AND agent = ?",
            (id, INSTALL, AGENT),
        )
        return {"forgotten": cursor.rowcount > 0}


if __name__ == "__main__":
    mcp.run(transport="stdio")
