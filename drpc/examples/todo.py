"""A todo-list daemon. Run it:

    uv run python examples/todo.py                        # TCP on 127.0.0.1:7700 (anonymous)
    uv run python examples/todo.py unix:/tmp/todo.sock    # Unix socket: you're your OS user
    uv run python examples/todo.py stdio                  # stdin/stdout: also your OS user

Then `nc -U /tmp/todo.sock` (or `nc 127.0.0.1 7700`) and type any of:

    help
    {"jsonrpc":"2.0","id":1,"method":"todo.add","params":{"text":"buy milk"}}
    remind me to call the dentist, it's urgent
"""

import itertools
import sys
from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Literal

from drpc import RequestContext, Service, Session, error

svc = Service(
    "todo",
    "A small in-memory todo list with tags and priorities.",
    instructions="Items are numbered by id. Prefer showing lists compactly, one item per line.",
    bytes_per_sec=2_000,  # per user: ~500 tokens/s of English, plenty of JSON-RPC
)

Priority = Literal["low", "normal", "high"]


@dataclass
class Item:
    id: int
    text: str
    priority: Priority = "normal"
    tags: list[str] = field(default_factory=list)
    done: bool = False
    created: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    by: str | None = None


items: dict[int, Item] = {}
ids = itertools.count(1)
last_seen: dict[str, str] = {}  # user -> when they last connected


# -- who's connected ----------------------------------------------------------
#
# The framework already knows who's on a Unix socket (the OS user) or stdio
# (whoever started us). This hook just remembers when each user was last here;
# TCP connections stay anonymous.


@svc.authenticate
def remember(session: Session) -> str | None:
    if session.user is not None:
        session.state["previous_session"] = last_seen.get(session.user)
        last_seen[session.user] = session.connected_at.isoformat(timespec="seconds")
    return session.user


@svc.llm_context
def user_history(session: Session) -> dict:
    """Tells the LLM when this user was last here."""
    if session.user is None:
        return {}
    prev = session.state.get("previous_session")
    return {"previous session": prev or "none, this is their first visit"}


@svc.llm_context
async def list_status(session: Session) -> str:
    open_count = sum(not i.done for i in items.values())
    return f"The list has {open_count} open item(s) out of {len(items)}."


# -- errors ------------------------------------------------------------------


@error(404, "no item with that id")
class NotFound:
    id: int


# -- the list ----------------------------------------------------------------


@dataclass
class Add:
    text: Annotated[str, "What needs doing"]
    priority: Priority = "normal"
    tags: Annotated[list[str], "Free-form labels, e.g. ['home']"] = field(default_factory=list)


@svc.method("todo.add")
def add(ctx: RequestContext, req: Add) -> Item:
    """Add an item to the list. Returns the new item, including its id."""
    item = Item(next(ids), req.text, req.priority, list(req.tags), by=ctx.session.user)
    items[item.id] = item
    return item


@dataclass
class Find:
    tag: Annotated[str | None, "Only items with this tag"] = None
    done: Annotated[bool | None, "true for finished items, false for open ones; omit for all"] = None
    contains: Annotated[str | None, "Only items whose text contains this, ignoring case"] = None


@svc.method("todo.list")
def list_items(req: Find) -> list[Item]:
    """List items, optionally filtered by tag, done-ness, and text. High priority first."""
    rank = {"high": 0, "normal": 1, "low": 2}
    found = [
        i for i in items.values()
        if (req.tag is None or req.tag in i.tags)
        and (req.done is None or i.done == req.done)
        and (req.contains is None or req.contains.lower() in i.text.lower())
    ]
    return sorted(found, key=lambda i: (rank[i.priority], i.id))


@dataclass
class MarkDone:
    id: int
    done: Annotated[bool, "false reopens the item"] = True


@svc.method("todo.done")
def mark_done(req: MarkDone) -> Item | NotFound:
    """Mark an item finished, or reopen it."""
    if req.id not in items:
        return NotFound(req.id)
    items[req.id].done = req.done
    return items[req.id]


@dataclass
class Update:
    id: int
    text: str | None = None
    priority: Priority | None = None
    tags: list[str] | None = None


@svc.method("todo.update")
def update(req: Update) -> Item | NotFound:
    """Change an item's text, priority, or tags. Omitted fields stay as they are."""
    item = items.get(req.id)
    if item is None:
        return NotFound(req.id)
    if req.text is not None:
        item.text = req.text
    if req.priority is not None:
        item.priority = req.priority
    if req.tags is not None:
        item.tags = list(req.tags)
    return item


@dataclass
class Remove:
    id: int


@svc.method("todo.remove")
def remove(req: Remove) -> bool | NotFound:
    """Delete an item for good. Returns true."""
    if items.pop(req.id, None) is None:
        return NotFound(req.id)
    return True


@dataclass
class Stats:
    open: int
    done: int
    open_by_tag: dict[str, int]


@svc.method("todo.stats")
async def stats() -> Stats:
    """Counts of open and finished items, and open items per tag."""
    open_items = [i for i in items.values() if not i.done]
    per_tag: dict[str, int] = {}
    for i in open_items:
        for t in i.tags:
            per_tag[t] = per_tag.get(t, 0) + 1
    return Stats(len(open_items), len(items) - len(open_items), per_tag)


if __name__ == "__main__":
    svc.run(sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1:7700")
