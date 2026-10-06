"""The endgame: a plain script against the todo daemon, no LLM in the loop.

This is the kind of thing a foreign LLM writes after it has poked at the
service in English for a while and learned the methods from the rpc> echoes.

    uv run python examples/todo.py &
    uv run python examples/script.py
"""

import sys

from drpc import Client, RpcError

with Client(sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1:7700") as c:
    milk = c.todo.add(text="buy milk", tags=["errands"])
    c.todo.add(text="file taxes", priority="high")
    c.todo.add("water the plants", "low", ["home"])  # positional params work too
    c.todo.done(id=milk["id"])

    for item in c.todo.list(done=False):
        print(f"[{item['priority']:>6}] #{item['id']} {item['text']}")
    print(c.todo.stats())

    try:
        c.todo.remove(id=999)
    except RpcError as e:
        print("expected failure:", e.code, e.message)
