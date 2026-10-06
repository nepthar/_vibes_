"""Transports: TCP, Unix socket, and stdio. One reader loop serves them all."""

import asyncio
import getpass
import logging
import os
import sys
from typing import Awaitable, Callable

from . import help
from .errors import INVALID_REQUEST, PARSE_ERROR, REFUSED
from .interpreter import Interpreter
from .peercred import peer_credentials
from .protocol import classify, encode_json, encode_text
from .session import Session
from .throttle import BYTES_PER_TOKEN

log = logging.getLogger("drpc")

MAX_LINE = 1 << 20  # 1 MiB per frame


async def converse(
    service,
    readline: Callable[[], Awaitable[bytes]],
    write: Callable[[bytes], Awaitable[None]],
    session: Session,
) -> None:
    """Serve one connection. Frames are answered strictly in the order they arrive,
    so a client can match replies to requests without looking at ids."""
    try:
        await service.admit(session)
    except PermissionError as e:
        log.info("refused #%d: %s", session.id, e)
        await write(encode_json(_error(REFUSED, f"connection refused: {e}")))
        return
    english = Interpreter(service, session)
    throttle = service.throttle_for(session)

    async def send(data: bytes) -> None:
        if throttle:
            throttle.charge(len(data))
        await write(data)

    while True:
        if throttle:
            await throttle.wait()
        try:
            raw = await readline()
        except ValueError:  # line longer than MAX_LINE
            await write(encode_json(_error(INVALID_REQUEST, f"frame exceeds {MAX_LINE} bytes")))
            return
        if not raw:
            return
        if throttle:
            throttle.charge(len(raw))

        kind, payload = classify(raw.decode("utf-8", errors="replace"))
        if kind == "rpc":
            reply = await service.handle_rpc(payload, session)
            if reply is not None:
                await send(encode_json(reply))
        elif kind == "bad_json":
            await send(encode_json(_error(PARSE_ERROR, f"parse error: {payload}")))
        elif kind == "text":
            await send(encode_text(await _english(service, session, english, payload, throttle)))


async def _english(service, session: Session, english: Interpreter, line: str, throttle) -> str:
    if answer := help.answer(service, line):
        return answer
    if session.user is None and not service.english_for_anonymous:
        return (
            "English is only available to identified users (connect over the Unix socket).\n"
            'Send "help" to see what this service does, or call its methods with JSON-RPC.'
        )
    before = english.tokens_used
    try:
        return await english.reply(line)
    except Exception as e:  # a bug on the English side shouldn't drop the connection
        log.exception("english reply failed")
        return f"[internal error: {type(e).__name__}: {e}]"
    finally:
        if throttle:
            throttle.charge((english.tokens_used - before) * BYTES_PER_TOKEN)


def _error(code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": None, "error": {"code": code, "message": message}}


async def _on_stream(service, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    peer = writer.get_extra_info("peername")
    if isinstance(peer, tuple):  # TCP: (host, port, ...)
        session = Session("tcp", f"{peer[0]}:{peer[1]}")
    else:
        session = Session("unix")
        if cred := peer_credentials(writer.get_extra_info("socket")):
            session.uid, session.pid, session.user = cred.uid, cred.pid, cred.username
    log.info("connect #%d %s %s", session.id, session.peer or session.transport, session.user or "")

    async def write(data: bytes) -> None:
        writer.write(data)
        await writer.drain()

    try:
        await converse(service, reader.readline, write, session)
    except (ConnectionResetError, BrokenPipeError):
        pass
    finally:
        log.info("disconnect #%d", session.id)
        writer.close()


async def _serve_stdio(service) -> None:
    # Reading stdin on a thread works for pipes and ttys alike, which the
    # event loop's pipe support doesn't promise on every platform.
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer

    async def readline() -> bytes:
        return await asyncio.to_thread(stdin.readline, MAX_LINE)

    async def write(data: bytes) -> None:
        stdout.write(data)
        stdout.flush()

    # Whoever can write our stdin started us, so they're our own OS user.
    session = Session("stdio", uid=os.getuid(), pid=os.getppid(), user=getpass.getuser())
    await converse(service, readline, write, session)


async def serve(service, address: str) -> None:
    def handler(r, w):
        return _on_stream(service, r, w)

    if address == "stdio":
        await _serve_stdio(service)
        return

    if address.startswith("unix:"):
        path = address.removeprefix("unix:")
        if os.path.exists(path):
            os.unlink(path)
        server = await asyncio.start_unix_server(handler, path, limit=MAX_LINE)
    else:
        host, _, port = address.rpartition(":")
        server = await asyncio.start_server(handler, host or "127.0.0.1", int(port), limit=MAX_LINE)

    log.info("%s listening on %s (%d methods)", service.name, address, len(service.methods))
    async with server:
        await server.serve_forever()
