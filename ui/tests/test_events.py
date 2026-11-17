import asyncio
import os
from pathlib import Path

import pytest
from test_api import jsonl
from test_models import FINDING, VERIFICATION

from arui.events import Events, classify

START = {"event": "start", "ts": "2026-11-09T00:00:00Z", "mode": "breadth", "windows": 1, "concurrency": 3, "log": "logs/x.log", "origin": "cli"}
DEAD_PID = 999999999


@pytest.fixture
def topic(tmp_path):
    t = tmp_path / "demo"
    (t / "state").mkdir(parents=True)
    (t / "ledger.jsonl").write_text(jsonl(FINDING))
    (t / "verifications.jsonl").write_text("")
    return t


def subscribe(events: Events) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    events.clients.add(q)
    return q


def take(q: asyncio.Queue) -> list[tuple[str, dict]]:
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def append(path, *records):
    with open(path, "a") as f:
        f.write(jsonl(*records))


def test_classify(tmp_path):
    root = tmp_path.resolve()
    cases = {
        "demo/ledger.jsonl": ("demo", "ledger"),
        "demo/verifications.jsonl": ("demo", "verifications"),
        "demo/papers.jsonl": ("demo", "papers"),
        "demo/tasks/t-00000001.json": ("demo", "tasks"),
        "demo/state/orchestrator.md": ("demo", "docs"),
        "demo/reports/r1.md": ("demo", "docs"),
        "demo/notes/t-00000001.md": ("demo", "docs"),
        "demo/.lock": ("demo", None),
        "demo/state/runs.jsonl": ("demo", None),
        "demo/logs/run-1.log": None,
        "demo/tasks/t-1.json.tmp": None,
        "demo/brief.md": None,
        "demo/.pi/memory/x.md": None,
        ".ui/demo-1.out": None,
        "ledger.jsonl": None,
    }
    for rel, want in cases.items():
        assert classify(root, str(root / rel)) == want, rel
    assert classify(root, "/elsewhere/demo/ledger.jsonl") is None


def test_topic_changed_groups_parts(topic):
    ev = Events(topic.parent)
    ev.prime()
    q = subscribe(ev)
    root = ev.root
    ev.handle({str(root / "demo/ledger.jsonl"), str(root / "demo/state/focus-fx-1.md"), str(root / "demo/notes/n.md"), str(root / "demo/logs/x.log")})
    assert take(q) == [("topic-changed", {"slug": "demo", "parts": ["docs", "ledger"]})]


def test_run_finished_on_end_line(topic):
    ev = Events(topic.parent)
    ev.prime()
    q = subscribe(ev)
    runs_file = str(ev.root / "demo/state/runs.jsonl")
    (topic / ".lock").write_text(str(os.getpid()))
    append(topic / "state/runs.jsonl", {**START, "runId": "r-00000001", "pid": os.getpid(), "mode": "focus", "focusKey": "fx-00000001"})
    ev.handle({runs_file})
    assert take(q) == [("run-started", {"slug": "demo", "runId": "r-00000001", "mode": "focus", "focusKey": "fx-00000001"})]

    append(topic / "ledger.jsonl", {**FINDING, "id": "f-22222222"}, {**FINDING, "id": "f-33333333"})
    append(topic / "verifications.jsonl", VERIFICATION)
    ev.handle({str(ev.root / "demo/ledger.jsonl")})
    assert take(q) == [("topic-changed", {"slug": "demo", "parts": ["ledger"]})]  # still running: no run event

    append(
        topic / "state/runs.jsonl", {"event": "end", "runId": "r-00000001", "ts": "2026-11-09T01:00:00Z", "exitCode": 0, "reason": "complete", "findings": 3}
    )
    (topic / ".lock").unlink()
    ev.handle({runs_file, str(ev.root / "demo/.lock")})
    finished = {"slug": "demo", "runId": "r-00000001", "mode": "focus", "reason": "complete", "newFindings": 2, "newVerifications": 1}
    assert take(q) == [("run-finished", finished)]
    ev.handle({runs_file})
    assert take(q) == []  # announced once


def test_run_lost_when_lock_vanishes(topic):
    (topic / ".lock").write_text(str(os.getpid()))
    (topic / "state/runs.jsonl").write_text(jsonl({**START, "runId": "r-00000001", "pid": DEAD_PID}, {**START, "runId": "r-00000002", "pid": os.getpid()}))
    ev = Events(topic.parent)
    ev.prime()  # r-00000001 was lost before the server started, so it is never announced
    assert list(ev.open_runs["demo"]) == ["r-00000002"]
    q = subscribe(ev)
    (topic / ".lock").unlink()
    ev.handle({str(ev.root / "demo/.lock")})
    assert take(q) == [("run-finished", {"slug": "demo", "runId": "r-00000002", "mode": "breadth", "reason": "lost", "newFindings": 0, "newVerifications": 0})]


def test_run_lost_when_lock_pid_dies(topic):
    # SIGKILL leaves the lock file with a dead pid and no file event; the poll catches it.
    ev = Events(topic.parent)
    ev.prime()
    q = subscribe(ev)
    (topic / ".lock").write_text(str(os.getpid()))
    append(topic / "state/runs.jsonl", {**START, "runId": "r-00000001", "pid": os.getpid()})
    ev.sync_runs("demo")
    (topic / ".lock").write_text(str(DEAD_PID))
    ev.sync_runs("demo")
    assert [(e, d.get("reason")) for e, d in take(q)] == [("run-started", None), ("run-finished", "lost")]


def test_stream_keep_alive(monkeypatch):
    monkeypatch.setattr("arui.events.KEEPALIVE_S", 0.01)

    async def go():
        s = Events(Path(".")).stream()
        await anext(s)
        return await anext(s)

    assert asyncio.run(go()) == ": keep-alive\n\n"


def test_stream_frames():
    async def go():
        ev = Events(Path("."))
        s = ev.stream()
        assert await anext(s) == ": connected\n\n"
        nxt = asyncio.ensure_future(anext(s))
        await asyncio.sleep(0)
        ev.publish("topic-changed", {"slug": "demo", "parts": ["ledger"]})
        assert await nxt == 'event: topic-changed\ndata: {"slug": "demo", "parts": ["ledger"]}\n\n'
        ev.loop = asyncio.get_running_loop()
        ev.close()  # server shutdown ends the stream
        with pytest.raises(StopAsyncIteration):
            await anext(s)
        assert not ev.clients

    asyncio.run(go())


def test_watch_emits_on_ledger_append(topic):
    async def go():
        ev = Events(topic.parent)
        q = subscribe(ev)
        stop = asyncio.Event()
        task = asyncio.create_task(ev.watch(stop))
        await asyncio.sleep(0.5)  # let the watcher start
        append(topic / "ledger.jsonl", {**FINDING, "id": "f-22222222"})
        event = await asyncio.wait_for(q.get(), 10)
        stop.set()
        await asyncio.wait_for(task, 5)
        return event

    event, data = asyncio.run(go())
    # FSEvents may also replay the fixture's own just-written files, so check inclusion only.
    assert event == "topic-changed" and data["slug"] == "demo" and "ledger" in data["parts"]
