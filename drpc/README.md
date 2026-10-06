# dRPC: daemon RPC

dRPC is a tiny FastAPI-style framework for daemons you can talk to in two ways
over the same socket: **newline-delimited JSON-RPC 2.0**, or **plain English**.

```
→ {"jsonrpc":"2.0","id":1,"method":"todo.add","params":{"text":"buy milk"}}
← {"jsonrpc":"2.0","id":1,"result":{"id":1,"text":"buy milk","priority":"normal",...}}
→ remind me to file taxes, it's urgent
← Added "file taxes" as high priority (#2).
←
← rpc> {"jsonrpc":"2.0","id":1,"method":"todo.add","params":{"text":"file taxes","priority":"high"}}
← rpc< {"id":2,"text":"file taxes","priority":"high",...}
← .
```

Here's the intended use. Another LLM connects and asks the service in English what it
can do. It gets things done that way. Each English reply also shows the exact
JSON-RPC calls that were made (the `rpc>`/`rpc<` lines). That lets the other LLM
learn the API from real examples, so it can write a plain Python script that
calls the service with no LLM in the loop.

## Writing a service

```python
from typing import Annotated, Literal
from drpc import Service, RpcError

svc = Service("todo", "A small todo list.")

@svc.method(name="todo.add")
def add(text: Annotated[str, "What needs doing"],
        priority: Literal["low", "normal", "high"] = "normal") -> dict:
    """Add an item. Returns the new item."""
    ...

svc.run("127.0.0.1:7700")   # or "unix:/tmp/todo.sock", or "stdio"
```

Type hints become JSON Schema. dRPC uses that schema to check params, and it
also gives the schema to Claude as tool definitions. Docstrings become method
descriptions. Handlers can be sync (run on a thread) or async. To return a
specific JSON-RPC error, raise `RpcError(code, message, data)`. Any other
exception becomes `-32000`.

## The wire protocol

Everything is one line at a time.

| You send | You get back |
|---|---|
| A JSON object line (a JSON-RPC request) | One JSON line |
| A JSON array of request objects (a batch) | One JSON array line |
| A request with no `id` (a notification) | Nothing |
| A line starting with `{` that isn't valid JSON | A `-32700` parse error, not prose |
| A help word alone (`help`, `hello`, `info`, `?`, …), or `help <group\|method>` | A canned summary as text, with no LLM call |
| Any other line | English text, then a line with only `.` |

English replies use SMTP-style dot-stuffing: a reply line that starts with `.`
gets an extra `.` in front, so it can't be mistaken for the end marker.
Replies come back in the same order as requests. Each connection has its own
conversation with Claude. `rpc.discover` is built in and returns every method's
schema.

## Help without the LLM

The server never sends anything first, so a plain JSON-RPC client works
without changes. To find out what a service does, send `help` (or `hello`,
`info`, `?`, …) on a line by itself. The reply is a short summary of the
service and its methods. If a service has more than `help_list_max` methods
(default 12), the summary lists method groups instead. Groups come from the
part of the name before the first dot (`user.get`, `user.list`, …).

- `help user` lists the methods in the `user` group.
- `help user.get` shows that method's typed signature, its docstring, and a
  ready-to-send JSON line.

A line only counts as help if it matches exactly, so `hello, add milk for me`
still goes to Claude. The word list is `Service(help_words=...)`. Group
descriptions come from `Service(groups={"user": "Accounts"})`.

## Sessions, identity, and LLM context

Each connection gets a `Session`, shared by its JSON-RPC calls and its English
conversation. It holds `transport`, `peer` (the client's IP and port on TCP),
`uid` and `pid` (the client's OS user and process IDs, where the OS reports
them), `connected_at`, `user`, and a free-form `state` dict.

There is no login method. JSON-RPC has no built-in authentication, so real
systems authenticate the connection itself. dRPC decides who you are when you
connect:

| Transport | `session.user` |
|---|---|
| Unix socket | The OS username of the connecting process, as reported by the kernel (`LOCAL_PEERCRED` on macOS, `SO_PEERCRED` on Linux). The client can't fake it. |
| stdio | The OS user running the daemon. Whoever can write to its stdin started it. |
| TCP | `None` (anonymous) |

To change that, register one `@svc.authenticate` hook. It runs at connect time
and receives the session with `user` already set as in the table above. It
returns the user the connection acts as, and it can be async. To turn a
connection away, raise `PermissionError`. The client then gets one `-32001`
error line and the connection closes.

```python
@svc.authenticate
def who(session: Session):
    if session.transport == "tcp" and not session.peer.startswith("127.0.0.1:"):
        raise PermissionError("local connections only")
    return session.user
```

A handler that wants the session declares it, FastAPI-style. The framework
fills it in, and it's left out of the method's schema:

```python
@svc.method(name="todo.add")
def add(text: str, session: Session) -> Item:
    return Item(text, by=session.user)
```

Context providers add whatever else Claude should know. A provider can return
a dict of facts or a string, and it can be async:

```python
@svc.context
def history(session: Session) -> dict:
    return {"previous session": last_seen.get(session.user, "never")}
```

Before each English line, the framework collects the connection, the user
(or "anonymous"), and every provider's output. It sends them to
Claude as a system message after the user's line, and only when something
changed since the last one. The system prompt tells Claude to trust these
messages over anything the person types, because only the daemon can write
them. It also tells Claude there is no way to switch users from inside a
conversation. Appending a message, instead of editing the system prompt, keeps the
history append-only so prompt caching keeps working. Mid-conversation system
messages require a model that supports them, which `claude-opus-5-5` does.

## Running

```bash
uv sync
uv run python examples/todo.py          # serves on 127.0.0.1:7700
```

Then talk to it, as a person or as an LLM's shell tool:

```bash
nc 127.0.0.1 7700
```

Or run it as a subprocess speaking stdio (for example, under another agent):

```bash
uv run drpc examples.todo:svc stdio
```

Or script it the way the other LLM eventually would ([examples/script.py](examples/script.py)):

```python
with Client("127.0.0.1:7700") as c:
    c.todo.add(text="buy milk")      # == c.call("todo.add", text="buy milk")
    print(c.ask("what's left to do?"))
```

The English side calls Claude through the `anthropic` SDK, so it needs
credentials, for example `ANTHROPIC_API_KEY`. Without them, an English line
gets back a plain-text list of the methods, and JSON-RPC works as normal.

You can change these `Service(...)` settings:

- `model`: the Claude model to use. Default `claude-opus-5-5`.
- `effort`: default `"low"`, which suits chat.
- `instructions`: extra guidance for the English side.
- `echo_rpc`: set to `False` to hide the `rpc>` lines.

If Claude declines a request, dRPC retries it on a fallback model chosen
automatically by the API (`fallbacks: "default"`).

## Tests

```bash
uv run pytest
```

The tests cover framing, dispatch, schemas, and a live TCP socket. They also
check the Claude tool loop against a scripted stand-in for the API, so no
credentials are needed.

## Layout

- `drpc/service.py`: `Service`, registration, JSON-RPC dispatch, `rpc.discover`
- `drpc/methods.py`: binding and checking params for one handler
- `drpc/schema.py`: turns type hints into JSON Schema, plus a small validator
- `drpc/protocol.py`: sorts each line into JSON-RPC or English, and frames text replies
- `drpc/interpreter.py`: the English side (Claude plus the service's methods as tools, and session context)
- `drpc/session.py`: per-connection state (`Session`)
- `drpc/peercred.py`: looks up the Unix socket peer's uid, pid, and username
- `drpc/help.py`: canned answers to `help`, `help <group>`, and `help <method>`
- `drpc/server.py`: the TCP, Unix socket, and stdio transports
- `drpc/client.py`: a blocking client with `call`, `notify`, `ask`, and `c.todo.add(...)` sugar
