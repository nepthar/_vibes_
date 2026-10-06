"""Everything except the LLM: framing, dispatch, schemas, and a live socket."""

import asyncio
import getpass
import json
import os
import socket
import tempfile
import threading
import time
from typing import Annotated, Literal

import pytest

from drpc import Client, RpcError, Service, Session
from drpc import help
from drpc.protocol import classify, decode_text_line, encode_text
from drpc.server import serve


def make_service() -> Service:
    svc = Service("calc", "Arithmetic")

    @svc.method
    def add(a: int, b: int = 1) -> int:
        """Add two integers."""
        return a + b

    @svc.method(name="math.mode")
    async def mode(kind: Literal["fast", "slow"], note: Annotated[str | None, "why"] = None) -> str:
        return kind

    @svc.method
    def boom() -> None:
        raise RuntimeError("kaboom")

    @svc.method
    def whoami(session: Session) -> dict:
        return {"user": session.user, "uid": session.uid, "pid": session.pid}

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
    assert results[0] == {"type": "tool_result", "tool_use_id": "t1", "content": "4"}
    assert results[1]["is_error"] is True
    assert {t["name"] for t in api.requests[0]["tools"]} == {"rpc__discover", "add", "math__mode", "boom", "whoami", "teapot"}
    assert api.requests[0]["fallbacks"] == "default"
    assert [m["role"] for m in interp.history] == ["user", "system", "assistant", "user", "assistant"]


def test_english_refusal_leaves_history_clean():
    interp, _ = fake_interpreter(make_service(), [NS(stop_reason="refusal", content=[])])
    assert "can't help" in asyncio.run(interp.reply("something"))
    assert interp.history == []


def test_context_is_sent_only_when_it_changes():
    svc = make_service()

    @svc.context
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


def test_session_is_injected_not_a_param():
    svc = Service("s")

    @svc.method
    def whoami(greeting: str, session: Session) -> str:
        return f"{greeting}, {session.user}"

    m = svc.methods["whoami"]
    assert m.order == ["greeting"] and "session" not in m.params
    sess = Session(user="jordan")
    resp = asyncio.run(svc.handle_rpc({"jsonrpc": "2.0", "id": 1, "method": "whoami", "params": ["hi"]}, sess))
    assert resp["result"] == "hi, jordan"


def big_service() -> Service:
    svc = Service("big", "Lots of methods", groups={"user": "Accounts"}, help_list_max=4)
    for name in ["user.get", "user.list", "user.delete", "billing.charge", "billing.refund"]:
        svc.method(name=name)(lambda id: None)
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
