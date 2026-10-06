"""Canned help: answered locally, no LLM involved.

A line that is just a help word ("help", "hello", "info", ...) gets a short
summary of the service. "help <group>" and "help <method>" drill down. Anything
else, including "hello, can you add milk", goes to the LLM as usual.
"""

from .protocol import dumps

HELP_WORDS = frozenset({"help", "hello", "hi", "hey", "info", "about", "usage", "man", "methods", "commands", "?"})


def answer(service, line: str) -> str | None:
    """The canned reply for `line`, or None if it isn't a help request."""
    words = line.strip().lower().split()
    if not words or words[0].rstrip("!.?,:") not in service.help_words and words[0] != "?":
        return None
    if len(words) == 1:
        return summary(service)
    if len(words) == 2:
        topic = line.strip().split()[1]
        if topic in service.methods:
            return method_detail(service.methods[topic])
        group = topic.rstrip(".*").lower()
        if group in _groups(service):
            return group_detail(service, group)
    return None


def summary(service) -> str:
    lines = [f"{service.name}: {service.description}".rstrip(": "),
             "Talk to me in English, or send JSON-RPC 2.0, one object per line."]
    methods = list(service.methods.values())
    if len(methods) <= service.help_list_max:
        lines += ["", "Methods:"] + [_line(m) for m in methods]
        lines += ["", 'Try "help <method>" for details.']
    else:
        lines += ["", f"Method groups ({len(methods)} methods):"]
        groups = _groups(service)
        width = max(len(g or "(none)") for g in groups) + 6
        for g, ms in groups.items():
            label = f"{g or '(none)'} ({len(ms)})"
            lines.append(f"  {label:<{width}}{service.groups.get(g, '')}".rstrip())
        lines += ["", 'Try "help <group>" to list a group\'s methods.']
    lines.append('rpc.discover returns everything as JSON Schema.')
    return "\n".join(lines)


def group_detail(service, group: str) -> str:
    ms = _groups(service)[group]
    head = f"{group}: {service.groups[group]}" if group in service.groups else group
    return "\n".join([head, ""] + [_line(m) for m in ms] + ["", 'Try "help <method>" for details.'])


def method_detail(m) -> str:
    lines = [f"{m.name}({_args(m, typed=True)}) -> {_type(m.result)}", ""]
    if m.description:
        lines += [m.description, ""]
    example = {"jsonrpc": "2.0", "id": 1, "method": m.name}
    if m.required:
        example["params"] = {n: _placeholder(m.params[n]) for n in m.required}
    lines += ["Example:", "  " + dumps(example)]
    return "\n".join(lines)


def _groups(service) -> dict[str, list]:
    out: dict[str, list] = {}
    for m in service.methods.values():
        out.setdefault(m.group, []).append(m)
    return out


def _line(m) -> str:
    return f"  {m.name}({_args(m)})  {m.summary}".rstrip()


def _args(m, typed: bool = False) -> str:
    parts = []
    for n in m.order:
        opt = "" if n in m.required else "?"
        parts.append(f"{n}{opt}: {_type(m.params[n])}" if typed else f"{n}{opt}")
    return ", ".join(parts)


def _type(schema: dict) -> str:
    if "enum" in schema:
        return " | ".join(dumps(v) for v in schema["enum"])
    if "anyOf" in schema:
        return " | ".join(_type(s) for s in schema["anyOf"])
    t = schema.get("type")
    if "title" in schema:
        return schema["title"]
    if t == "array":
        return f"{_type(schema.get('items', {}))}[]"
    return t or "any"


def _placeholder(schema: dict):
    if "enum" in schema:
        return schema["enum"][0]
    if "anyOf" in schema:
        return _placeholder(schema["anyOf"][0])
    return {"string": "...", "integer": 1, "number": 1.0, "boolean": True, "array": [], "object": {}}.get(
        schema.get("type"), None
    )
