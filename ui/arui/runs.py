"""Run status from the topic lock and state/runs.jsonl (read-only)."""

import os
from pathlib import Path

from pydantic import TypeAdapter, ValidationError

from arui.models import RunEnd, RunEvent, RunStart

EVENT = TypeAdapter(RunEvent)


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:  # exists, owned by another user (EPERM), as in acquireLock
        return True
    except (ProcessLookupError, OverflowError, ValueError):
        return False


def lock_pid(topic: Path) -> int | None:
    """Pid of the live process holding topics/<slug>/.lock, else None."""
    try:
        pid = int((topic / ".lock").read_text().strip())
    except (OSError, ValueError):
        return None
    return pid if pid > 0 and pid_alive(pid) else None


def read_events(topic: Path) -> list[RunStart | RunEnd]:
    """Valid runs.jsonl lines in file order; a truncated or unknown line is skipped."""
    path = topic / "state" / "runs.jsonl"
    if not path.exists():
        return []
    events = []
    for line in path.read_text().splitlines():
        if line.strip():
            try:
                events.append(EVENT.validate_json(line))
            except ValidationError:
                pass
    return events


def open_start(events: list[RunStart | RunEnd], pid: int | None) -> RunStart | None:
    """The start event of the running process: the latest unended start with the lock's pid."""
    ended = {e.runId for e in events if isinstance(e, RunEnd)}
    starts = [e for e in events if isinstance(e, RunStart) and e.runId not in ended and e.pid == pid]
    return starts[-1] if pid is not None and starts else None


def fold(events: list[RunStart | RunEnd], pid: int | None) -> list[dict]:
    """One entry per run, newest first. An unended start is running if it holds the lock, else lost."""
    ends = {e.runId: e for e in events if isinstance(e, RunEnd)}
    running = open_start(events, pid)
    runs = []
    for s in events:
        if not isinstance(s, RunStart):
            continue
        end = ends.get(s.runId)
        reason = end.reason if end else None if s is running else "lost"
        runs.append(
            {
                "runId": s.runId,
                "mode": s.mode,
                "focusKey": s.focusKey,
                "target": s.target,
                "origin": s.origin,
                "start": s.ts,
                "end": end.ts if end else None,
                "reason": reason,
                "running": s is running,
            }
        )
    return runs[::-1]


def status(topic: Path) -> dict:
    """`running` with the open start event while a live pid holds the lock, else `idle` with the last run."""
    pid = lock_pid(topic)
    events = read_events(topic)
    if pid is not None:
        start = open_start(events, pid)
        return {"state": "running", "pid": pid, "start": start.model_dump(mode="json") if start else None}
    runs = fold(events, None)
    return {"state": "idle", "last": runs[0] if runs else None}
