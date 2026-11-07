"""
test_log_stream.py — the public view of the buffered log ring.
"""
from __future__ import annotations

import logging

import pytest

from de_shell import ipc, log_stream


@pytest.fixture
def handler(monkeypatch):
    sent: list[dict] = []
    monkeypatch.setattr(ipc, "emit", sent.append)
    installed = log_stream.IPCLogHandler(level=logging.DEBUG)
    monkeypatch.setattr(log_stream, "_handler", installed)
    installed.sent = sent
    return installed


def record(message: str, level: int = logging.WARNING) -> logging.LogRecord:
    return logging.LogRecord("app.module", level, __file__, 1, message, None, None)


class TestBuffered:
    def test_empty_before_install(self, monkeypatch):
        monkeypatch.setattr(log_stream, "_handler", None)
        assert log_stream.buffered() == []

    def test_returns_the_entries_a_live_log_message_carries(self, handler):
        handler.emit(record("first"))
        handler.emit(record("second"))
        entries = log_stream.buffered()
        assert [entry["msg"] for entry in entries] == ["first", "second"]
        assert entries == handler.sent

    def test_returns_copies(self, handler):
        handler.emit(record("kept"))
        log_stream.buffered()[0]["msg"] = "changed"
        log_stream.buffered().clear()
        assert [entry["msg"] for entry in log_stream.buffered()] == ["kept"]

    def test_backfill_sends_the_same_entries(self, handler):
        handler.emit(record("history"))
        log_stream.emit_backfill()
        backfill = handler.sent[-1]
        assert backfill["type"] == "log_backfill"
        assert backfill["entries"] == log_stream.buffered()
