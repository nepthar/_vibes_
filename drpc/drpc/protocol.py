"""The wire format.

Everything is a line. A line that parses as a JSON object (or an array of
them, a JSON-RPC batch) is a JSON-RPC 2.0 frame and gets one JSON line back,
unless it was a notification. Any other line is English, and gets an English
reply: lines of text ending with a line holding only ".", with leading dots
doubled (SMTP-style dot-stuffing) so a "." inside the reply can't end it early.

A line that starts with "{" but isn't valid JSON is a parse error rather than
English: a script that sends a mangled frame wants a JSON error back, not prose.
"""

import dataclasses
import json

TERMINATOR = "."


def classify(line: str) -> tuple[str, object]:
    """Returns ("rpc", obj), ("text", str), ("bad_json", why), or ("blank", None)."""
    s = line.strip()
    if not s:
        return "blank", None
    if s[0] in "{[":
        try:
            obj = json.loads(s)
        except json.JSONDecodeError as e:
            if s[0] == "{":
                return "bad_json", str(e)
            return "text", s
        if isinstance(obj, dict):
            return "rpc", obj
        if isinstance(obj, list) and obj and all(isinstance(o, dict) for o in obj):
            return "rpc", obj
    return "text", s


def _default(o):
    if dataclasses.is_dataclass(o) and not isinstance(o, type):
        return dataclasses.asdict(o)
    if isinstance(o, (set, frozenset, tuple)):
        return list(o)
    return str(o)


def dumps(obj) -> str:
    return json.dumps(obj, default=_default, separators=(",", ":"), ensure_ascii=False)


def encode_json(obj) -> bytes:
    return (dumps(obj) + "\n").encode()


def encode_text(text: str) -> bytes:
    lines = text.rstrip("\n").split("\n") if text.strip() else []
    stuffed = ["." + ln if ln.startswith(".") else ln for ln in lines]
    return ("\n".join(stuffed + [TERMINATOR]) + "\n").encode()


def decode_text_line(line: str) -> str | None:
    """One line of an English reply; None at the terminator."""
    line = line.rstrip("\r\n")
    if line == TERMINATOR:
        return None
    return line[1:] if line.startswith("..") else line
