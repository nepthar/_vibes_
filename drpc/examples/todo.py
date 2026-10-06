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

from drpc import RpcError, Service, Session

svc = Service(
    "todo",
    "A small in-memory todo list with tags and priorities.",
    instructions="Items are numbered by id. Prefer showing lists compactly, one item per line.",
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


@svc.context
def user_history(session: Session) -> dict:
    """Tells the LLM when this user was last here."""
    if session.user is None:
        return {}
    prev = session.state.get("previous_session")
    return {"previous session": prev or "none, this is their first visit"}


@svc.context
async def list_status(session: Session) -> str:
    open_count = sum(not i.done for i in items.values())
    return f"The list has {open_count} open item(s) out of {len(items)}."


# -- the list ----------------------------------------------------------------


def _get(id: int) -> Item:
    if id not in items:
        raise RpcError(404, f"no item with id {id}")
    return items[id]


@svc.method(name="todo.add")
def add(
    text: Annotated[str, "What needs doing"],
    priority: Priority = "normal",
    tags: Annotated[list[str], "Free-form labels, e.g. ['home']"] = [],
    session: Session = None,
) -> Item:
    """Add an item to the list. Returns the new item, including its id."""
    item = Item(next(ids), text, priority, list(tags), by=session.user)
    items[item.id] = item
    return item


@svc.method(name="todo.list")
def list_items(
    tag: Annotated[str | None, "Only items with this tag"] = None,
    done: Annotated[bool | None, "true for finished items, false for open ones; omit for all"] = None,
) -> list[Item]:
    """List items, optionally filtered by tag and/or done-ness. High priority first."""
    rank = {"high": 0, "normal": 1, "low": 2}
    found = [
        i for i in items.values()
        if (tag is None or tag in i.tags) and (done is None or i.done == done)
    ]
    return sorted(found, key=lambda i: (rank[i.priority], i.id))


@svc.method(name="todo.done")
def mark_done(id: int, done: bool = True) -> Item:
    """Mark an item finished (or pass done=false to reopen it)."""
    item = _get(id)
    item.done = done
    return item


@svc.method(name="todo.update")
def update(id: int, text: str | None = None, priority: Priority | None = None, tags: list[str] | None = None) -> Item:
    """Change an item's text, priority, or tags. Omitted fields stay as they are."""
    item = _get(id)
    if text is not None:
        item.text = text
    if priority is not None:
        item.priority = priority
    if tags is not None:
        item.tags = list(tags)
    return item


@svc.method(name="todo.remove")
def remove(id: int) -> bool:
    """Delete an item for good. Returns true."""
    _get(id)
    del items[id]
    return True


@svc.method(name="todo.stats")
async def stats() -> dict:
    """Counts of open and finished items, and open items per tag."""
    open_items = [i for i in items.values() if not i.done]
    per_tag: dict[str, int] = {}
    for i in open_items:
        for t in i.tags:
            per_tag[t] = per_tag.get(t, 0) + 1
    return {"open": len(open_items), "done": len(items) - len(open_items), "open_by_tag": per_tag}


if __name__ == "__main__":
    svc.run(sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1:7700")
