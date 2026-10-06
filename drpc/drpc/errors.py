"""JSON-RPC 2.0 error codes and the exception handlers raise to send one."""

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

    def __init__(self, code: int, message: str, data=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data

    def to_json(self) -> dict:
        err = {"code": self.code, "message": self.message}
        if self.data is not None:
            err["data"] = self.data
        return err

    def __repr__(self) -> str:
        return f"RpcError({self.code}, {self.message!r})"
