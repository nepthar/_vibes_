"""Service: register methods, dispatch JSON-RPC, describe yourself."""

import asyncio
import inspect
import logging
from typing import Callable

from . import help
from .errors import INVALID_REQUEST, METHOD_NOT_FOUND, SERVER_ERROR, RpcError
from .methods import Method
from .request import RequestContext
from .session import Session
from .throttle import Throttle

log = logging.getLogger("drpc")

DEFAULT_MODEL = "claude-opus-5-5"


class Service:
    """A daemon you talk to in JSON-RPC or in English.

        svc = Service("todo", "A tiny todo list")

        @dataclass
        class Add:
            text: str

        @svc.method("todo.add")
        def add(ctx: RequestContext, req: Add) -> Item:
            '''Add an item.'''

        svc.run("127.0.0.1:7700")
    """

    def __init__(
        self,
        name: str,
        description: str = "",
        *,
        instructions: str = "",
        model: str = DEFAULT_MODEL,
        effort: str = "low",
        echo_rpc: bool = True,
        groups: dict[str, str] | None = None,
        help_words: frozenset[str] = help.HELP_WORDS,
        help_list_max: int = 12,
        english_for_anonymous: bool = False,
        bytes_per_sec: float | None = None,
        burst_bytes: float = 64_000,
    ):
        self.name = name
        self.description = description
        self.instructions = instructions  # extra guidance for the English side
        self.model = model
        self.effort = effort
        self.echo_rpc = echo_rpc  # append the JSON-RPC calls the LLM made to its replies
        self.groups = {"rpc": "Built-in protocol methods", **(groups or {})}  # group -> one-line description
        self.help_words = help_words  # a line that is just one of these gets the canned summary
        self.help_list_max = help_list_max  # above this many methods, the summary lists groups instead
        self.methods: dict[str, Method] = {}
        self.context_providers: list[Callable] = []
        self.auth_hook: Callable | None = None
        self.english_for_anonymous = english_for_anonymous  # LLM costs money; anonymous peers get help + JSON-RPC
        self.bytes_per_sec = bytes_per_sec  # None: unthrottled
        self.burst_bytes = burst_bytes
        self._throttles: dict[str, Throttle] = {}  # one per user, shared across their connections
        self._register("rpc.discover", self.discover)

    # -- registration --------------------------------------------------------

    def method(self, fn_or_name: Callable | str | None = None, *, name: str | None = None):
        """Decorator: @svc.method, @svc.method("todo.add"), or @svc.method(name="todo.add").

        Without a name, the method is called by the function's name.
        """
        if isinstance(fn_or_name, str):
            name, fn_or_name = fn_or_name, None

        def register(f: Callable) -> Callable:
            self._register(name or f.__name__, f)
            return f

        return register(fn_or_name) if fn_or_name is not None else register

    def llm_context(self, fn: Callable) -> Callable:
        """Decorator. Registers a function that tells the LLM about the current session.

        It takes the Session and returns a dict of facts, a string, or None; it
        may be async. Providers run before every English line, and whatever
        they return is shown to the LLM as context from the daemon itself.
        """
        self.context_providers.append(fn)
        return fn

    def authenticate(self, fn: Callable) -> Callable:
        """Decorator. Decides who a new connection is, before it can send anything.

        It gets the Session, with `user` already set to the transport's answer
        (the OS user on a Unix socket or stdio, None over TCP), and returns the
        user this connection acts as. Raise PermissionError to turn it away.
        May be async.
        """
        self.auth_hook = fn
        return fn

    async def admit(self, session: Session) -> None:
        if self.auth_hook is None:
            return
        user = self.auth_hook(session)
        session.user = await user if inspect.isawaitable(user) else user

    def throttle_for(self, session: Session) -> Throttle | None:
        """The byte budget this session draws from: its user's, or its own if anonymous."""
        if self.bytes_per_sec is None:
            return None
        if session.user is None:
            return Throttle(self.bytes_per_sec, self.burst_bytes)
        key = str(session.user)
        if key not in self._throttles:
            self._throttles[key] = Throttle(self.bytes_per_sec, self.burst_bytes)
        return self._throttles[key]

    def _register(self, name: str, fn: Callable) -> None:
        if name in self.methods:
            raise ValueError(f"method {name!r} is already registered")
        self.methods[name] = Method.from_function(name, fn)

    # -- introspection -------------------------------------------------------

    def discover(self) -> dict:
        """Describe this service: every method with its params and result as JSON Schema."""
        return {
            "service": self.name,
            "description": self.description,
            "protocol": (
                "Newline-delimited. A JSON object line is a JSON-RPC 2.0 request and gets one JSON line "
                "back. Any other line is English and gets text back, ended by a line holding only '.'."
            ),
            "methods": [
                {
                    "name": m.name,
                    "description": m.description,
                    "params": m.input_schema(),
                    "result": m.result,
                    "errors": [e.to_json() for e in m.errors],
                }
                for m in self.methods.values()
            ],
        }

    # -- JSON-RPC dispatch ---------------------------------------------------

    async def handle_rpc(self, msg: dict | list, session: Session | None = None) -> dict | list | None:
        """One request or a batch in; the response (None for notifications) out."""
        session = session or Session()
        if isinstance(msg, list):
            replies = await asyncio.gather(*(self._handle_one(m, session) for m in msg))
            return [r for r in replies if r is not None] or None
        return await self._handle_one(msg, session)

    async def _handle_one(self, req: dict, session: Session) -> dict | None:
        rid = req.get("id")
        notification = "id" not in req
        try:
            if req.get("jsonrpc") != "2.0" or not isinstance(req.get("method"), str):
                raise RpcError(INVALID_REQUEST, 'expected {"jsonrpc": "2.0", "method": "...", ...}')
            headers = req.get("headers", {})
            if not isinstance(headers, dict):
                raise RpcError(INVALID_REQUEST, '"headers" must be an object')
            method = self.methods.get(req["method"])
            if method is None:
                raise RpcError(METHOD_NOT_FOUND, f"no such method: {req['method']}")
            ctx = RequestContext(session, method.name, rid, headers)
            result = await method.call(req.get("params"), ctx)
        except RpcError as e:
            err = e
        except Exception as e:
            log.exception("handler %s failed", req.get("method"))
            err = RpcError(SERVER_ERROR, f"{type(e).__name__}: {e}")
        else:
            return None if notification else {"jsonrpc": "2.0", "id": rid, "result": result}

        if notification and err.code != INVALID_REQUEST:
            return None
        return {"jsonrpc": "2.0", "id": rid, "error": err.to_json()}

    # -- running -------------------------------------------------------------

    def run(self, address: str = "127.0.0.1:7700") -> None:
        """Serve forever. `address` is "host:port", "unix:/path/to.sock", or "stdio"."""
        from .server import serve

        logging.basicConfig(level=logging.INFO, format="%(asctime)s drpc %(message)s")
        try:
            asyncio.run(serve(self, address))
        except KeyboardInterrupt:
            pass
