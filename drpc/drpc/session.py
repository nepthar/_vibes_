"""Per-connection state, shared by the JSON-RPC and English sides.

Who the user is gets settled when the connection opens, never by a login
call. On a Unix socket it's the OS user who connected (the kernel says so);
over stdio it's whoever started the daemon; over TCP it's nobody, unless the
service's @svc.authenticate hook decides otherwise.

Handlers reach it through their RequestContext, as ctx.session. It never
appears in a JSON-RPC message.
"""

import itertools
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

_ids = itertools.count(1)


@dataclass
class Session:
    transport: str = "local"  # "tcp", "unix", "stdio", or "local" (in-process)
    peer: str | None = None  # remote address, when the transport has one
    uid: int | None = None  # the peer's OS user id (Unix sockets and stdio)
    pid: int | None = None  # the peer's process id, when the OS reports it
    connected_at: datetime = field(default_factory=lambda: datetime.now().astimezone())
    id: int = field(default_factory=lambda: next(_ids))
    user: Any = None  # who this connection acts as; the framework only ever str()s it
    state: dict = field(default_factory=dict)  # anything the service wants to remember

    def describe(self) -> dict[str, str]:
        where = self.transport
        if self.peer:
            where += f" from {self.peer}"
        if self.pid is not None:
            where += f", pid {self.pid}"
        return {
            "connection": f"#{self.id}, {where}, opened {self.connected_at.isoformat(timespec='seconds')}",
            "user": str(self.user) if self.user is not None else "anonymous (nobody is identified)",
        }
