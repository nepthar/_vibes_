"""A small blocking client, the kind of thing you'd end up scripting against.

    with Client("127.0.0.1:7700") as c:
        c.call("todo.add", text="buy milk")
        c.todo.add(text="buy milk")   # same thing
        print(c.ask("what's on my list?"))
"""

import json
import socket

from .errors import RpcError
from .protocol import decode_text_line, dumps


class Client:
    def __init__(self, address: str = "127.0.0.1:7700", timeout: float | None = 300):
        if address.startswith("unix:"):
            self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self._sock.connect(address.removeprefix("unix:"))
        else:
            host, _, port = address.rpartition(":")
            self._sock = socket.create_connection((host or "127.0.0.1", int(port)))
        self._sock.settimeout(timeout)
        self._file = self._sock.makefile("rwb")
        self._next_id = 0

    def call(self, method: str, *args, **kwargs):
        """Call a method; returns its result or raises RpcError."""
        if args and kwargs:
            raise TypeError("pass params by position or by name, not both")
        self._next_id += 1
        req = {"jsonrpc": "2.0", "id": self._next_id, "method": method}
        if args or kwargs:
            req["params"] = list(args) if args else kwargs
        self._send(dumps(req))
        resp = json.loads(self._readline())
        if "error" in resp:
            e = resp["error"]
            raise RpcError(e["code"], e["message"], e.get("data"))
        return resp["result"]

    def notify(self, method: str, **params) -> None:
        """Fire and forget: no id, so the server sends nothing back."""
        req = {"jsonrpc": "2.0", "method": method}
        if params:
            req["params"] = params
        self._send(dumps(req))

    def ask(self, text: str) -> str:
        """Say something in English; returns the reply."""
        if "\n" in text:
            raise ValueError("one line at a time: English ends at the newline")
        self._send(text)
        lines = []
        while (line := decode_text_line(self._readline())) is not None:
            lines.append(line)
        return "\n".join(lines)

    def __getattr__(self, name: str) -> "_Path":
        if name.startswith("_"):
            raise AttributeError(name)
        return _Path(self, name)

    def _send(self, line: str) -> None:
        self._file.write(line.encode() + b"\n")
        self._file.flush()

    def _readline(self) -> str:
        raw = self._file.readline()
        if not raw:
            raise ConnectionError("server closed the connection")
        return raw.decode()

    def close(self) -> None:
        self._file.close()
        self._sock.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class _Path:
    """c.todo.add(...) -> c.call("todo.add", ...)"""

    def __init__(self, client: Client, name: str):
        self._client, self._name = client, name

    def __getattr__(self, name: str) -> "_Path":
        return _Path(self._client, f"{self._name}.{name}")

    def __call__(self, *args, **kwargs):
        return self._client.call(self._name, *args, **kwargs)
