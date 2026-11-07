"""
test_ipc_read_messages.py — the stdin pump stops reading at ``quit``.

A read still in flight when the interpreter shuts down holds stdin's buffer
lock; on Python 3.13 that thread is parked forever and closing stdin at exit
aborts the process. So nothing after ``quit`` may be read.
"""
from __future__ import annotations

import asyncio
import io
import sys
import types

from de_shell import ipc


def read_all(lines: bytes, monkeypatch) -> tuple[list[dict], io.BytesIO]:
    stream = io.BytesIO(lines)
    monkeypatch.setattr(sys, "stdin", types.SimpleNamespace(buffer=stream))

    async def collect():
        return [message async for message in ipc.read_messages(asyncio.get_running_loop())]

    return asyncio.run(collect()), stream


class TestReadMessages:
    def test_reading_stops_after_quit(self, monkeypatch):
        before = b'{"type": "action", "action": "a"}\n{"type": "quit"}\n'
        messages, stream = read_all(before + b'{"type": "tick"}\n', monkeypatch)
        assert [m["type"] for m in messages] == ["action", "quit"]
        assert stream.tell() == len(before)

    def test_quit_inside_a_payload_does_not_stop_reading(self, monkeypatch):
        lines = b'{"type": "action", "payload": {"label": "quit"}}\n{"type": "tick"}\n'
        messages, _ = read_all(lines, monkeypatch)
        assert [m["type"] for m in messages] == ["action", "tick"]

    def test_end_of_input_still_ends_the_stream(self, monkeypatch):
        messages, _ = read_all(b'{"type": "tick"}\n', monkeypatch)
        assert [m["type"] for m in messages] == ["tick"]
