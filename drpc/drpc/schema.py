"""Type hints in, JSON Schema out — and a small validator for that same subset.

Supported: str, int, float, bool, None, list[X], tuple[X, ...], set[X], dict,
Literal[...], X | Y, Optional[X], Any, Annotated[X, "description"], and
dataclasses (as objects).
"""

import dataclasses
import inspect
import types
from typing import Annotated, Any, Literal, Union, get_args, get_origin, get_type_hints

_PRIMITIVES = {str: "string", int: "integer", float: "number", bool: "boolean", type(None): "null"}
_SEQUENCES = (list, tuple, set, frozenset)


def type_schema(tp) -> dict:
    if tp is inspect.Parameter.empty or tp is Any:
        return {}
    origin = get_origin(tp)

    if origin is Annotated:
        base, *meta = get_args(tp)
        schema = type_schema(base)
        desc = next((m for m in meta if isinstance(m, str)), None)
        if desc:
            schema["description"] = desc
        return schema

    if origin in (Union, types.UnionType):
        options = [type_schema(a) for a in get_args(tp)]
        return {"anyOf": options}

    if origin is Literal:
        return {"enum": list(get_args(tp))}

    if origin in _SEQUENCES or tp in _SEQUENCES:
        schema = {"type": "array"}
        args = [a for a in get_args(tp) if a is not Ellipsis]
        if args:
            schema["items"] = type_schema(args[0])
        return schema

    if origin is dict or tp is dict:
        args = get_args(tp)
        if len(args) == 2:
            return {"type": "object", "additionalProperties": type_schema(args[1])}
        return {"type": "object"}

    if tp in _PRIMITIVES:
        return {"type": _PRIMITIVES[tp]}

    if dataclasses.is_dataclass(tp):  # results only; params stay JSON-shaped
        hints = get_type_hints(tp, include_extras=True)
        props = {f.name: type_schema(hints.get(f.name, Any)) for f in dataclasses.fields(tp)}
        return {"type": "object", "title": tp.__name__, "properties": props}

    return {}


def _type_ok(value, name: str) -> bool:
    match name:
        case "string":
            return isinstance(value, str)
        case "integer":
            return isinstance(value, int) and not isinstance(value, bool)
        case "number":
            return isinstance(value, (int, float)) and not isinstance(value, bool)
        case "boolean":
            return isinstance(value, bool)
        case "null":
            return value is None
        case "array":
            return isinstance(value, list)
        case "object":
            return isinstance(value, dict)
    return True


def check(value, schema: dict, path: str) -> None:
    """Raise ValueError naming `path` if `value` doesn't fit `schema`."""
    if "anyOf" in schema:
        for option in schema["anyOf"]:
            try:
                check(value, option, path)
                return
            except ValueError:
                pass
        raise ValueError(f"{path}: {value!r} matches none of {schema['anyOf']}")

    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path}: {value!r} is not one of {schema['enum']}")

    if "type" in schema and not _type_ok(value, schema["type"]):
        raise ValueError(f"{path}: expected {schema['type']}, got {type(value).__name__}")

    if "items" in schema and isinstance(value, list):
        for i, item in enumerate(value):
            check(item, schema["items"], f"{path}[{i}]")
