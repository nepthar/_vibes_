"""RequestContext: everything about a call that isn't its params.

JSON-RPC carries the method and params. The context sits above that: which
connection the call came in on, any headers sent alongside it, and whether
the LLM made it on someone's behalf.
"""

from dataclasses import dataclass, field
from typing import Any

from .session import Session


@dataclass
class RequestContext:
    session: Session
    method: str
    id: Any = None  # the JSON-RPC id; None for notifications
    headers: dict[str, Any] = field(default_factory=dict)  # the request's "headers" member
    from_llm: bool = False  # True when the server LLM made this call
