"""A registered method: the handler, its schema, and argument binding."""

import asyncio
import inspect
from dataclasses import dataclass, field
from typing import Callable, get_type_hints

from .errors import INVALID_PARAMS, RpcError
from .schema import check, type_schema
from .session import Session


@dataclass
class Method:
    name: str
    fn: Callable
    description: str
    params: dict  # name -> JSON Schema
    required: list[str]
    result: dict
    order: list[str] = field(default_factory=list)  # for positional params
    session_param: str | None = None  # filled in by the framework, not the caller

    @classmethod
    def from_function(cls, name: str, fn: Callable) -> "Method":
        sig = inspect.signature(fn)
        hints = get_type_hints(fn, include_extras=True)
        params, required, order, session_param = {}, [], [], None
        for p in sig.parameters.values():
            if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
                raise TypeError(f"{name}: *args/**kwargs can't be described as RPC params")
            hint = hints.get(p.name, p.annotation)
            if isinstance(hint, type) and issubclass(hint, Session):
                session_param = p.name
                continue
            schema = type_schema(hint)
            if p.default is p.empty:
                required.append(p.name)
            else:
                schema["default"] = p.default
            params[p.name] = schema
            order.append(p.name)
        return cls(
            name=name,
            fn=fn,
            description=inspect.getdoc(fn) or "",
            params=params,
            required=required,
            result=type_schema(hints.get("return", sig.return_annotation)),
            order=order,
            session_param=session_param,
        )

    @property
    def group(self) -> str:
        return self.name.split(".")[0] if "." in self.name else ""

    @property
    def summary(self) -> str:
        return self.description.split("\n\n")[0].replace("\n", " ")

    def input_schema(self) -> dict:
        return {
            "type": "object",
            "properties": self.params,
            "required": self.required,
            "additionalProperties": False,
        }

    def bind(self, raw) -> dict:
        """Turn JSON-RPC `params` (array, object, or absent) into kwargs."""
        if raw is None:
            raw = {}
        if isinstance(raw, list):
            if len(raw) > len(self.order):
                raise RpcError(INVALID_PARAMS, f"{self.name} takes at most {len(self.order)} params")
            raw = dict(zip(self.order, raw))
        if not isinstance(raw, dict):
            raise RpcError(INVALID_PARAMS, "params must be an array or an object")

        unknown = set(raw) - set(self.params)
        if unknown:
            raise RpcError(INVALID_PARAMS, f"unknown params: {', '.join(sorted(unknown))}")
        missing = [n for n in self.required if n not in raw]
        if missing:
            raise RpcError(INVALID_PARAMS, f"missing params: {', '.join(missing)}")
        for key, value in raw.items():
            try:
                check(value, self.params[key], key)
            except ValueError as e:
                raise RpcError(INVALID_PARAMS, str(e)) from None
        return raw

    async def call(self, raw_params, session: Session | None = None):
        kwargs = self.bind(raw_params)
        if self.session_param:
            kwargs[self.session_param] = session or Session()
        if inspect.iscoroutinefunction(self.fn):
            return await self.fn(**kwargs)
        return await asyncio.to_thread(self.fn, **kwargs)
