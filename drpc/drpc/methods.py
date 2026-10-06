"""A registered method: the handler, its schemas, and calling it.

Handlers look like

    def handler(ctx: RequestContext, req: SomeRequest) -> Result | SomeError | OtherError

Both parameters are optional and are recognized by their annotation:
`RequestContext` gets the context, and a dataclass gets the params, built
from them. The dataclass's fields are the method's params, in order (for
callers that pass params by position). Members of the return annotation that
are declared error types (see errors.error) are the errors it can return;
everything else is the result.
"""

import asyncio
import dataclasses
import inspect
import types
from dataclasses import dataclass
from typing import Any, Callable, Union, get_args, get_origin, get_type_hints

from .errors import INVALID_PARAMS, RpcError, declared_error
from .request import RequestContext
from .schema import check, type_schema


@dataclass
class ErrorSpec:
    code: int
    message: str
    name: str
    data: dict  # JSON Schema of the error's fields

    def to_json(self) -> dict:
        return {"code": self.code, "message": self.message, "name": self.name, "data": self.data}


@dataclass
class Method:
    name: str
    fn: Callable
    description: str
    params: dict  # name -> JSON Schema
    required: list[str]
    order: list[str]  # for positional params
    result: dict
    errors: list[ErrorSpec]
    request_type: type | None
    ctx_param: str | None
    req_param: str | None

    @classmethod
    def from_function(cls, name: str, fn: Callable) -> "Method":
        hints = get_type_hints(fn, include_extras=True)
        ctx_param = req_param = request_type = None
        for p in inspect.signature(fn).parameters.values():
            hint = hints.get(p.name)
            if isinstance(hint, type) and issubclass(hint, RequestContext):
                ctx_param = p.name
            elif dataclasses.is_dataclass(hint) and req_param is None:
                req_param, request_type = p.name, hint
            else:
                raise TypeError(
                    f"{name}: parameter {p.name!r} must be annotated as RequestContext "
                    "or as a dataclass holding the params (one of each at most)"
                )

        params, required, order = _request_fields(request_type) if request_type else ({}, [], [])
        result, errors = _split_return(hints.get("return", Any))
        return cls(
            name=name,
            fn=fn,
            description=inspect.getdoc(fn) or "",
            params=params,
            required=required,
            order=order,
            result=result,
            errors=errors,
            request_type=request_type,
            ctx_param=ctx_param,
            req_param=req_param,
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
        """Turn JSON-RPC `params` (array, object, or absent) into checked field values."""
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

    async def call(self, raw_params, ctx: RequestContext):
        """Run the handler. Returns its result; a returned error type is raised as RpcError."""
        fields = self.bind(raw_params)
        args = {}
        if self.ctx_param:
            args[self.ctx_param] = ctx
        if self.req_param:
            args[self.req_param] = self.request_type(**fields)
        if inspect.iscoroutinefunction(self.fn):
            result = await self.fn(**args)
        else:
            result = await asyncio.to_thread(self.fn, **args)

        if spec := declared_error(result):
            code, message = spec
            raise RpcError(
                code,
                message,
                dataclasses.asdict(result),
                schema=type_schema(type(result)),
                name=type(result).__name__,
            )
        return result


def _request_fields(request_type: type) -> tuple[dict, list[str], list[str]]:
    hints = get_type_hints(request_type, include_extras=True)
    params, required, order = {}, [], []
    for f in dataclasses.fields(request_type):
        schema = type_schema(hints[f.name])
        if f.default is not dataclasses.MISSING:
            schema["default"] = f.default
        elif f.default_factory is not dataclasses.MISSING:
            schema["default"] = f.default_factory()
        else:
            required.append(f.name)
        params[f.name] = schema
        order.append(f.name)
    return params, required, order


def _split_return(annotation) -> tuple[dict, list[ErrorSpec]]:
    members = list(get_args(annotation)) if get_origin(annotation) in (Union, types.UnionType) else [annotation]
    errors, results = [], []
    for m in members:
        if spec := declared_error(m):
            errors.append(ErrorSpec(spec[0], spec[1], m.__name__, type_schema(m)))
        else:
            results.append(m)
    if not results:
        result = {}
    elif len(results) == 1:
        result = type_schema(results[0])
    else:
        result = {"anyOf": [type_schema(r) for r in results]}
    return result, errors
