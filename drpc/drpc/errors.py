"""JSON-RPC 2.0 errors: the standard codes, declared error types, and RpcError.

A handler reports an expected failure by returning an instance of a declared
error type, which also lists the error in the method's schema:

    @error(404, "no such item")
    class NotFound:
        id: int

    @svc.method("todo.done")
    def done(ctx: RequestContext, req: MarkDone) -> Item | NotFound:
        ...
        return NotFound(req.id)

The message is fixed per type, so it never carries data; the instance's
fields go in the error's `data`. Raising RpcError still works for anything
ad hoc.
"""

import dataclasses

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
SERVER_ERROR = -32000  # an unexpected exception inside a handler
REFUSED = -32001  # the authenticate hook turned the connection away


class RpcError(Exception):
    """Raise from a handler to return a specific JSON-RPC error.

    The client raises it too, when the server answers with an error.
    """

    def __init__(self, code: int, message: str, data=None, *, schema: dict | None = None, name: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data
        self.schema = schema  # the shape of `data`, when it came from a declared error type
        self.name = name  # that type's name

    def to_json(self) -> dict:
        err = {"code": self.code, "message": self.message}
        if self.data is not None:
            err["data"] = self.data
        return err

    def __repr__(self) -> str:
        return f"RpcError({self.code}, {self.message!r})"


def error(code: int, message: str):
    """Class decorator: declare an error type. Makes the class a dataclass if it isn't one."""

    def declare(cls):
        if not dataclasses.is_dataclass(cls):
            cls = dataclasses.dataclass(cls)
        cls.__drpc_error__ = (code, message)
        return cls

    return declare


def declared_error(tp) -> tuple[int, str] | None:
    """(code, message) if `tp` (a class or an instance) is a declared error type."""
    return getattr(tp, "__drpc_error__", None)
