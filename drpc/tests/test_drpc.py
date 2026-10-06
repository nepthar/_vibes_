"""Everything except the LLM: framing, dispatch, schemas, and a live socket."""

import asyncio
import getpass
import json
import os
import re
import socket
import tempfile
import threading
import time
from dataclasses import dataclass
from typing import Annotated, Literal

import pytest

from drpc import Client, RequestContext, RpcError, Service, Session, error
from drpc import help
from drpc.protocol import classify, decode_text_line, encode_text
from drpc.server import serve


@dataclass
class Add:
    a: int
    b: int = 1


@dataclass
class Mode:
    kind: Literal["fast", "slow"]
    note: Annotated[str | None, "why"] = None


@error(422, "that number is too big")
class TooBig:
    limit: int


def make_service() -> Service:
    svc = Service("calc", "Arithmetic")

    @svc.method
    def add(req: Add) -> int | TooBig:
        """Add two integers."""
        if req.a + req.b > 1000:
            return TooBig(1000)
        return req.a + req.b

    @svc.method("math.mode")
    async def mode(ctx: RequestContext, req: Mode) -> str:
        return req.kind

    @svc.method
    def boom() -> None:
        raise RuntimeError("kaboom")

    @svc.method
    def whoami(ctx: RequestContext) -> dict:
        s = ctx.session
        return {"user": s.user, "uid": s.uid, "pid": s.pid}

    @svc.method
    def echo_ctx(ctx: RequestContext) -> dict:
        return {"method": ctx.method, "id": ctx.id, "headers": ctx.headers, "from_llm": ctx.from_llm}

    @svc.method
    def teapot() -> None:
        raise RpcError(418, "I'm a teapot", {"brew": "earl grey"})

    return svc


def rpc(svc, msg):
    return asyncio.run(svc.handle_rpc(msg))


# -- framing -----------------------------------------------------------------


@pytest.mark.parametrize(
    "line,kind",
    [
        ('{"jsonrpc":"2.0","method":"x"}', "rpc"),
        ('[{"jsonrpc":"2.0","method":"x"}]', "rpc"),
        ("what can you do?", "text"),
        ("[note] buy milk", "text"),  # a bracket isn't enough to be JSON
        ("[1, 2]", "text"),  # JSON, but not a request or a batch
        ('"just a string"', "text"),
        ('{"jsonrpc": "2.0", "method": ', "bad_json"),
        ("   ", "blank"),
    ],
)
def test_classify(line, kind):
    assert classify(line)[0] == kind


def test_text_framing_round_trip():
    text = "line one\n.hidden\n.\n\nend"
    wire = encode_text(text).decode().splitlines()
    assert wire[-1] == "."
    assert wire.count(".") == 1  # the bare "." in the body got stuffed
    decoded = []
    for ln in wire:
        if (d := decode_text_line(ln)) is None:
            break
        decoded.append(d)
    assert "\n".join(decoded) == text


# -- dispatch ----------------------------------------------------------------


def test_call_by_name_and_position():
    svc = make_service()
    assert rpc(svc, {"jsonrpc": "2.0", "id": 1, "method": "add", "params": {"a": 2, "b": 3}})["result"] == 5
    assert rpc(svc, {"jsonrpc": "2.0", "id": 2, "method": "add", "params": [2]})["result"] == 3


@pytest.mark.parametrize(
    "params,needle",
    [
        ({}, "missing params: a"),
        ({"a": "2"}, "expected integer"),
        ({"a": True}, "expected integer"),
        ({"a": 1, "c": 2}, "unknown params: c"),
        ([1, 2, 3], "at most 2"),
    ],
)
def test_invalid_params(params, needle):
    resp = rpc(make_service(), {"jsonrpc": "2.0", "id": 1, "method": "add", "params": params})
    assert resp["error"]["code"] == -32602
    assert needle in resp["error"]["message"]


def test_literal_and_optional():
    svc = make_service()
    ok = rpc(svc, {"jsonrpc": "2.0", "id": 1, "method": "math.mode", "params": {"kind": "fast", "note": None}})
    assert ok["result"] == "fast"
    bad = rpc(svc, {"jsonrpc": "2.0", "id": 1, "method": "math.mode", "params": {"kind": "medium"}})
    assert bad["error"]["code"] == -32602


def test_errors():
    svc = make_service()
    assert rpc(svc, {"jsonrpc": "2.0", "id": 1, "method": "nope"})["error"]["code"] == -32601
    assert rpc(svc, {"id": 1, "method": "add"})["error"]["code"] == -32600
    crash = rpc(svc, {"jsonrpc": "2.0", "id": 1, "method": "boom"})["error"]
    assert crash["code"] == -32000 and "kaboom" in crash["message"]
    tea = rpc(svc, {"jsonrpc": "2.0", "id": 1, "method": "teapot"})["error"]
    assert tea == {"code": 418, "message": "I'm a teapot", "data": {"brew": "earl grey"}}


def test_notifications_and_batches():
    svc = make_service()
    assert rpc(svc, {"jsonrpc": "2.0", "method": "add", "params": [1]}) is None
    out = rpc(
        svc,
        [
            {"jsonrpc": "2.0", "id": "a", "method": "add", "params": [1, 1]},
            {"jsonrpc": "2.0", "method": "add", "params": [1]},  # notification: no reply
            {"jsonrpc": "2.0", "id": "c", "method": "nope"},
        ],
    )
    assert [r["id"] for r in out] == ["a", "c"]


def test_discover_schema():
    doc = rpc(make_service(), {"jsonrpc": "2.0", "id": 1, "method": "rpc.discover"})["result"]
    methods = {m["name"]: m for m in doc["methods"]}
    assert methods["add"]["params"]["required"] == ["a"]
    assert methods["add"]["params"]["properties"]["b"] == {"type": "integer", "default": 1}
    note = methods["math.mode"]["params"]["properties"]["note"]
    assert note["description"] == "why"
    assert {"type": "null"} in note["anyOf"]


# -- over a real socket --------------------------------------------------------


@pytest.fixture
def address():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    addr = f"127.0.0.1:{port}"
    svc = make_service()
    threading.Thread(target=lambda: asyncio.run(serve(svc, addr)), daemon=True).start()
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port)).close()
            break
        except OSError:
            time.sleep(0.02)
    return addr


def test_client_over_tcp(address):
    with Client(address) as c:
        assert c.add(a=40, b=2) == 42
        assert c.math.mode("slow") == "slow"
        c.notify("add", a=1)
        with pytest.raises(RpcError) as e:
            c.add()
        assert e.value.code == -32602


def test_raw_wire(address):
    host, port = address.split(":")
    with socket.create_connection((host, int(port))) as s:
        f = s.makefile("rwb")
        f.write(b'{"jsonrpc":"2.0","id":7,"method":"add","params":[1,2]}\n')
        f.write(b'{"jsonrpc": "2.0", broken\n')
        f.flush()
        assert json.loads(f.readline()) == {"jsonrpc": "2.0", "id": 7, "result": 3}
        assert json.loads(f.readline())["error"]["code"] == -32700


# -- the English side, with a scripted stand-in for the API ----------------------

from types import SimpleNamespace as NS

from drpc.interpreter import Interpreter


class FakeMessages:
    def __init__(self, script):
        self.script, self.requests = list(script), []

    async def create(self, **kwargs):
        self.requests.append({**kwargs, "messages": list(kwargs["messages"])})
        return self.script.pop(0)


def fake_interpreter(svc, script):
    interp = Interpreter(svc)
    messages = FakeMessages(script)
    interp._client = NS(beta=NS(messages=messages))
    return interp, messages


def test_english_calls_tools_and_echoes_rpc():
    svc = make_service()
    interp, api = fake_interpreter(svc, [
        NS(stop_reason="tool_use", content=[
            NS(type="text", text="Adding."),
            NS(type="tool_use", id="t1", name="add", input={"a": 2, "b": 2}),
            NS(type="tool_use", id="t2", name="math__mode", input={"kind": "warp"}),
        ]),
        NS(stop_reason="end_turn", content=[NS(type="text", text="2 + 2 = 4.")]),
    ])
    reply = asyncio.run(interp.reply("what's 2+2?"))

    assert reply.startswith("2 + 2 = 4.")
    assert 'rpc> {"jsonrpc":"2.0","id":1,"method":"add","params":{"a":2,"b":2}}\nrpc< 4' in reply
    assert 'rpc> {"jsonrpc":"2.0","id":2,"method":"math.mode"' in reply and "rpc< error -32602" in reply

    results = api.requests[1]["messages"][-1]["content"]
    assert results[0]["content"].startswith("Stored as r1: integer.")  # the LLM never sees the 4
    assert results[1]["is_error"] is True
    assert {t["name"] for t in api.requests[0]["tools"]} == {"rpc__discover", "add", "math__mode", "boom", "whoami", "echo_ctx", "teapot"}
    assert api.requests[0]["fallbacks"] == "default"
    assert [m["role"] for m in interp.history] == ["user", "system", "assistant", "user", "assistant"]


def test_english_refusal_leaves_history_clean():
    interp, _ = fake_interpreter(make_service(), [NS(stop_reason="refusal", content=[])])
    assert "can't help" in asyncio.run(interp.reply("something"))
    assert interp.history == []


def test_context_is_sent_only_when_it_changes():
    svc = make_service()

    @svc.llm_context
    async def mood(session):
        return {"mood": session.state.get("mood", "calm")}

    done = lambda text: NS(stop_reason="end_turn", content=[NS(type="text", text=text)])
    interp, api = fake_interpreter(svc, [done("a"), done("b"), done("c")])
    interp.session.user = "jordan"
    asyncio.run(interp.reply("one"))
    asyncio.run(interp.reply("two"))
    interp.session.state["mood"] = "grumpy"
    asyncio.run(interp.reply("three"))

    systems = [m["content"] for m in interp.history if m["role"] == "system"]
    assert len(systems) == 2
    assert "- user: jordan" in systems[0] and "- mood: calm" in systems[0]
    assert "- mood: grumpy" in systems[1]
    first = api.requests[0]["messages"]
    assert [m["role"] for m in first] == ["user", "system"]  # system follows the user's line


# -- sessions and help -----------------------------------------------------------


def test_context_carries_session_and_headers():
    svc = make_service()
    m = svc.methods["echo_ctx"]
    assert m.params == {} and m.ctx_param == "ctx"
    sess = Session(user="jordan")
    req = {"jsonrpc": "2.0", "id": 9, "method": "echo_ctx", "headers": {"trace": "abc"}}
    assert asyncio.run(svc.handle_rpc(req, sess))["result"] == {
        "method": "echo_ctx", "id": 9, "headers": {"trace": "abc"}, "from_llm": False,
    }
    bad = asyncio.run(svc.handle_rpc({**req, "headers": [1]}, sess))
    assert bad["error"]["code"] == -32600


def test_declared_errors():
    svc = make_service()
    resp = rpc(svc, {"jsonrpc": "2.0", "id": 1, "method": "add", "params": [999, 2]})
    assert resp["error"] == {"code": 422, "message": "that number is too big", "data": {"limit": 1000}}
    m = svc.methods["add"]
    assert m.result == {"type": "integer"}
    assert [e.to_json()["name"] for e in m.errors] == ["TooBig"]
    doc = rpc(svc, {"jsonrpc": "2.0", "id": 1, "method": "rpc.discover"})["result"]
    add = next(x for x in doc["methods"] if x["name"] == "add")
    assert add["errors"][0]["data"]["properties"] == {"limit": {"type": "integer"}}
    assert "422 TooBig: that number is too big  {limit: integer}" in help.answer(svc, "help add")


def test_handler_signature_is_checked():
    svc = Service("s")
    with pytest.raises(TypeError, match="must be annotated"):
        @svc.method
        def bad(x: int) -> int:
            return x


@dataclass
class ById:
    id: int


def big_service() -> Service:
    def noop(req: ById) -> None:
        return None

    svc = Service("big", "Lots of methods", groups={"user": "Accounts"}, help_list_max=4)
    for name in ["user.get", "user.list", "user.delete", "billing.charge", "billing.refund"]:
        svc.method(name)(noop)
    return svc


@pytest.mark.parametrize("line", ["help", "HELLO", "hi!", "info", "?", "  help  "])
def test_help_words(line):
    assert help.answer(make_service(), line).startswith("calc: Arithmetic")


@pytest.mark.parametrize("line", ["hello, can you add 2 and 2", "help me add numbers", "what's up"])
def test_not_help(line):
    assert help.answer(make_service(), line) is None


def test_help_lists_methods_or_groups():
    small = help.answer(make_service(), "help")
    assert "add(a, b?)  Add two integers." in small
    big = help.answer(big_service(), "help")
    assert "user (3)" in big and "Accounts" in big and "billing (2)" in big
    assert "user.get" not in big


def test_help_drilldown():
    svc = big_service()
    group = help.answer(svc, "help user")
    assert group.startswith("user: Accounts") and "user.delete(id)" in group
    method = help.answer(make_service(), "help math.mode")
    assert 'math.mode(kind: "fast" | "slow", note?: string | null) -> string' in method
    assert '{"jsonrpc":"2.0","id":1,"method":"math.mode","params":{"kind":"fast"}}' in method


def test_help_over_the_wire(address):
    with Client(address) as c:
        assert c.ask("hello").startswith("calc: Arithmetic")
        assert c.add(a=1) == 2  # JSON-RPC still works after a text exchange


# -- who's connected -------------------------------------------------------------


def start(svc, addr, probe):
    threading.Thread(target=lambda: asyncio.run(serve(svc, addr)), daemon=True).start()
    for _ in range(100):
        try:
            probe().close()
            return
        except OSError:
            time.sleep(0.02)


def unix_socket(svc):
    # Unix socket paths max out around 104 bytes, so skip pytest's long tmp_path.
    path = os.path.join(tempfile.mkdtemp(prefix="drpc", dir="/tmp"), "s.sock")

    def probe():
        s = socket.socket(socket.AF_UNIX)
        s.connect(path)
        return s

    start(svc, f"unix:{path}", probe)
    return f"unix:{path}"


def test_unix_peer_is_the_os_user():
    addr = unix_socket(make_service())
    with Client(addr) as c:
        me = c.whoami()
    assert me == {"user": getpass.getuser(), "uid": os.getuid(), "pid": os.getpid()}


def test_tcp_is_anonymous(address):
    with Client(address) as c:
        assert c.whoami()["user"] is None


def test_authenticate_hook_can_rename_and_refuse():
    svc = make_service()
    closed = False

    @svc.authenticate
    async def gate(session):
        if closed:
            raise PermissionError("closed for maintenance")
        return f"{session.user}@box"

    addr = unix_socket(svc)
    with Client(addr) as c:
        assert c.whoami()["user"] == f"{getpass.getuser()}@box"
    closed = True
    with Client(addr) as c, pytest.raises(RpcError) as e:
        c.whoami()
    assert e.value.code == -32001 and "closed for maintenance" in e.value.message


# -- blind results ----------------------------------------------------------------

from drpc.blind import TemplateError, describe, render, resolve_refs

STORE = {
    "r1": {"x": 1.23456, "y": -2.5, "name": "ball", "tags": ["red", "round"], "owner": None},
    "r2": [{"id": 1, "text": "milk"}, {"id": 2, "text": "eggs"}],
    "r3": {"home": 2, "work": 1},
    "r4": [],
}


@pytest.mark.parametrize(
    "template,expected",
    [
        ("The ball is at {r1.x:.2f}, {r1.y:.2f}", "The ball is at 1.23, -2.50"),
        ("{r1.name:>6}|{r1.tags[-1]}|{r1.owner}", "  ball|round|null"),
        ("{r1.tags}", '["red","round"]'),
        ("Items:\n- #{r2[*].id} {r2[*].text}\ndone", "Items:\n- #1 milk\n- #2 eggs\ndone"),
        ("{r3[*].key}={r3[*].value}", "home=2\nwork=1"),
        ("Nothing:\n- {r4[*].text}\nend", "Nothing:\nend"),
        ('send {"id": {r2[0].id}, "params": {"a": [1]}}', 'send {"id": 1, "params": {"a": [1]}}'),
        ("plain {braces} and {rx} stay", "plain {braces} and {rx} stay"),
    ],
)
def test_render(template, expected):
    assert render(template, STORE) == expected


@pytest.mark.parametrize(
    "template,why",
    [
        ("{r1.__class__}", "no field '__class__'"),  # dunder names aren't fields of a JSON object
        ("{r1.x.__class__.__init__.__globals__}", "no field"),
        ("{r1.missing}", "no field 'missing'"),
        ("{r9}", "there's no r9"),
        ("{r2[5].id}", "out of range"),
        ("{r1.x:999999999}", "isn't allowed"),
        ("{r1.x:{r1.y}}", "unclosed or nested field"),
        ("{r1.name:.2f}", "Unknown format code"),
        ("{r2[*].id} {r1.tags[*]}", "one list"),
        ("{r1.name[*]}", "isn't a list"),
    ],
)
def test_render_rejects(template, why):
    with pytest.raises(TemplateError, match=re.escape(why)):
        render(template, STORE)


def test_describe_never_includes_values():
    item = {"type": "object", "title": "Item",
            "properties": {"id": {"type": "integer"}, "text": {"type": "string"}}}
    text = describe("r2", STORE["r2"], {"type": "array", "items": item})
    assert "list of Item, 2 items" in text and "Item = {id: integer, text: string}" in text
    assert "milk" not in text and "eggs" not in text
    assert "map of string to integer, 2 entries" in describe("r3", STORE["r3"],
        {"type": "object", "additionalProperties": {"type": "integer"}})
    assert "home" not in describe("r3", STORE["r3"], {"type": "object", "additionalProperties": {}})


def test_refs():
    params = {"id": {"$ref": "r2[1].id"}, "pair": [{"$ref": "r1.x"}, 3], "text": "$ref"}
    assert resolve_refs(params, STORE) == {"id": 2, "pair": [1.23456, 3], "text": "$ref"}
    with pytest.raises(TemplateError):
        resolve_refs({"id": {"$ref": "r2[*].id"}}, STORE)


def test_english_chains_by_ref_and_fills_template():
    svc = make_service()
    interp, api = fake_interpreter(svc, [
        NS(stop_reason="tool_use", content=[NS(type="tool_use", id="t1", name="add", input={"a": 40, "b": 1})]),
        NS(stop_reason="tool_use", content=[NS(type="tool_use", id="t2", name="add",
                                               input={"a": {"$ref": "r1"}})]),
        NS(stop_reason="end_turn", content=[NS(type="text", text="That's {r2:03d}, see {r9}.")]),  # bad ref
        NS(stop_reason="end_turn", content=[NS(type="text", text="That's {r2:03d}.")]),
    ])
    reply = asyncio.run(interp.reply("add 40 and 1, then add 1 to that"))
    assert reply.startswith("That's 042.")
    assert '"params":{"a":41}' in reply  # the echo shows the substituted value
    retry = api.requests[3]["messages"][-1]["content"]
    assert "there's no r9" in retry
    sent = json.dumps([m["content"] for m in api.requests[3]["messages"]], default=repr)
    assert "41" not in sent and "42" not in sent  # values never went to the model


def test_internal_errors_are_opaque_to_the_llm():
    interp, api = fake_interpreter(make_service(), [
        NS(stop_reason="tool_use", content=[NS(type="tool_use", id="t1", name="boom", input={})]),
        NS(stop_reason="end_turn", content=[NS(type="text", text="It broke.")]),
    ])
    reply = asyncio.run(interp.reply("boom"))
    result = api.requests[1]["messages"][-1]["content"][0]
    assert result["is_error"] and "kaboom" not in result["content"]
    assert "kaboom" in reply  # the person still sees it in the echo


# -- anonymous English and throttling -----------------------------------------------

from drpc.throttle import Throttle


def test_anonymous_gets_help_but_not_english(address):
    with Client(address) as c:
        assert "only available to identified users" in c.ask("what can you do?")
        assert c.ask("help").startswith("calc: Arithmetic")


def test_throttle_waits_off_debt():
    t = Throttle(bytes_per_sec=1000, burst=100)
    t.charge(100)
    start = time.monotonic()
    asyncio.run(t.wait())
    assert time.monotonic() - start < 0.05  # within budget: no wait
    t.charge(150)  # 150 bytes in debt at 1000 B/s
    start = time.monotonic()
    asyncio.run(t.wait())
    assert 0.1 < time.monotonic() - start < 0.3


def test_throttle_is_shared_per_user():
    svc = Service("s", bytes_per_sec=10)
    a, b = Session(user="jordan"), Session(user="jordan")
    assert svc.throttle_for(a) is svc.throttle_for(b)
    assert svc.throttle_for(Session()) is not svc.throttle_for(Session())
    assert Service("s").throttle_for(a) is None


def test_llm_calls_get_a_context_and_blind_error_data():
    interp, api = fake_interpreter(make_service(), [
        NS(stop_reason="tool_use", content=[
            NS(type="tool_use", id="t1", name="echo_ctx", input={}),
            NS(type="tool_use", id="t2", name="add", input={"a": 999, "b": 999}),
        ]),
        NS(stop_reason="end_turn", content=[NS(type="text", text="via llm: {r1.from_llm}; limit {r2.limit}")]),
    ])
    reply = asyncio.run(interp.reply("go"))
    assert reply.startswith("via llm: true; limit 1000")
    err = api.requests[1]["messages"][-1]["content"][1]
    assert err["is_error"] and err["content"].startswith("422 TooBig: that number is too big")
    assert "TooBig = {limit: integer}" in err["content"] and "1000" not in err["content"]
