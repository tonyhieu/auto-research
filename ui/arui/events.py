"""Watch topics/ and broadcast change and run events to SSE clients."""

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path

from watchfiles import awatch

from arui import runs
from arui.models import RunStart

DEBOUNCE_MS = 1000
KEEPALIVE_S = 15
LOST_POLL_S = 5  # a SIGKILLed run leaves its .lock behind, so no file event marks it lost
FILE_PARTS = {"ledger.jsonl": "ledger", "verifications.jsonl": "verifications", "papers.jsonl": "papers"}
DIR_PARTS = {"tasks": "tasks", "state": "docs", "reports": "docs", "notes": "docs"}
RUN_FILES = {(".lock",), ("state", "runs.jsonl")}


def classify(root: Path, path: str) -> tuple[str, str | None] | None:
    """(slug, part) for a watched file, part None for run files (.lock, state/runs.jsonl); None if unwatched."""
    try:
        rel = Path(path).relative_to(root).parts
    except ValueError:
        return None
    if len(rel) < 2 or rel[0].startswith("."):  # topics/.ui is the server's own dir
        return None
    slug, rest = rel[0], rel[1:]
    if rest in RUN_FILES:
        return slug, None
    if len(rest) == 1:
        part = FILE_PARTS.get(rest[0])
    elif len(rest) == 2 and (rest[0] != "tasks" or rest[1].endswith(".json")):
        part = DIR_PARTS.get(rest[0])
    else:
        part = None
    return (slug, part) if part else None


def under(base: Path, path: str) -> bool:
    try:
        Path(path).resolve().relative_to(base)
        return True
    except ValueError:
        return False

def line_count(path: Path) -> int:
    try:
        with path.open() as f:
            return sum(1 for line in f if line.strip())
    except OSError:
        return 0


class Events:
    def __init__(self, root: Path, portfolio: Path | None = None):
        self.root = root.resolve()
        self.portfolio = portfolio.resolve() if portfolio else None
        self.clients: set[asyncio.Queue] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.seen: dict[str, int] = {}  # slug -> valid runs.jsonl events already handled
        # slug -> runId -> (start event, (ledger lines, verification lines) when the start was seen)
        self.open_runs: dict[str, dict[str, tuple[RunStart, tuple[int, int]]]] = {}

    def publish(self, event: str, data: dict) -> None:
        for q in self.clients:
            q.put_nowait((event, data))

    def counts(self, slug: str) -> tuple[int, int]:
        t = self.root / slug
        return line_count(t / "ledger.jsonl"), line_count(t / "verifications.jsonl")

    def prime(self) -> None:
        """Adopt current state without announcing it: only the run holding the lock stays open."""
        for d in sorted(self.root.iterdir()) if self.root.is_dir() else []:
            if d.is_dir() and not d.name.startswith("."):
                events = runs.read_events(d)
                self.seen[d.name] = len(events)
                start = runs.open_start(events, runs.lock_pid(d))
                self.open_runs[d.name] = {start.runId: (start, self.counts(d.name))} if start else {}

    def handle(self, paths: set[str]) -> None:
        parts: dict[str, set[str]] = {}
        if self.portfolio and any(under(self.portfolio, p) for p in paths):
            self.publish("driver-changed", {})
        for p in paths:
            c = classify(self.root, p)
            if c:
                slug, part = c
                parts.setdefault(slug, set())
                if part:
                    parts[slug].add(part)
        for slug, ps in sorted(parts.items()):
            if ps:
                self.publish("topic-changed", {"slug": slug, "parts": sorted(ps)})
            self.sync_runs(slug)

    def sync_runs(self, slug: str) -> None:
        topic = self.root / slug
        pid = runs.lock_pid(topic)  # read before events: the CLI appends `end` before it removes the lock
        events = runs.read_events(topic)
        new = events[self.seen.get(slug, 0) :]
        self.seen[slug] = len(events)
        opened = self.open_runs.setdefault(slug, {})
        for e in new:
            if isinstance(e, RunStart):
                opened[e.runId] = (e, self.counts(slug))
                self.publish("run-started", {"slug": slug, "runId": e.runId, "mode": e.mode, "focusKey": e.focusKey})
            elif e.runId in opened:
                self.finish(slug, e.runId, e.reason)
        # The CLI takes the lock before appending `start`, so a just-seen start already holds it.
        for run_id, (start, _) in list(opened.items()):
            if start.pid != pid:
                self.finish(slug, run_id, "lost")

    def finish(self, slug: str, run_id: str, reason: str) -> None:
        start, (f0, v0) = self.open_runs[slug].pop(run_id)
        f1, v1 = self.counts(slug)
        self.publish("run-finished", {"slug": slug, "runId": run_id, "mode": start.mode, "reason": reason, "newFindings": f1 - f0, "newVerifications": v1 - v0})

    async def poll_lost(self) -> None:
        while True:
            await asyncio.sleep(LOST_POLL_S)
            for slug in [s for s, o in self.open_runs.items() if o]:
                self.sync_runs(slug)

    def close(self) -> None:
        """End every open stream so server shutdown need not wait on them; safe from a signal handler."""

        def end_all():
            for q in self.clients:
                q.put_nowait(None)

        if self.loop:
            self.loop.call_soon_threadsafe(end_all)

    async def watch(self, stop: asyncio.Event | None = None) -> None:
        self.loop = asyncio.get_running_loop()
        self.root.mkdir(parents=True, exist_ok=True)
        self.prime()
        poll = asyncio.create_task(self.poll_lost())
        roots = [self.root]
        if self.portfolio:
            self.portfolio.mkdir(parents=True, exist_ok=True)
            roots.append(self.portfolio)
        def watched(_change, p: str) -> bool:
            return classify(self.root, p) is not None or (self.portfolio is not None and under(self.portfolio, p))

        try:
            async for changes in awatch(*roots, watch_filter=watched, debounce=DEBOUNCE_MS, stop_event=stop):
                self.handle({p for _, p in changes})
        finally:
            poll.cancel()

    async def stream(self) -> AsyncIterator[str]:
        """SSE frames for one client; the browser reconnects on its own and refetches."""
        q: asyncio.Queue = asyncio.Queue()
        self.clients.add(q)
        try:
            yield ": connected\n\n"
            while True:
                try:
                    item = await asyncio.wait_for(q.get(), KEEPALIVE_S)
                except TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if item is None:  # close()
                    return
                event, data = item
                yield f"event: {event}\ndata: {json.dumps(data)}\n\n"
        finally:
            self.clients.discard(q)
