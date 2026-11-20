"""Run status from the topic lock and state/runs.jsonl, plus spawning and stopping bin/research."""

import os
import re
import signal
import subprocess
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from pydantic import TypeAdapter, ValidationError

from arui.models import FindingInput, RunEnd, RunEvent, RunStart

EVENT = TypeAdapter(RunEvent)
REPO = Path(__file__).resolve().parents[2]
RESEARCH = REPO / "bin" / "research"
PREPRINT = REPO / "bin" / "preprint"
REGEN = REPO / "bin" / "regen-report"
PREPRINTS = REPO / "pre-prints"
BRIEF_CAP = 12_000  # as in topic.ts
SPAWN_GRACE_S = 2.0  # a child that exits this fast failed before its run log existed
TAIL_CHARS = 2000
# A free-text focus target becomes the focus-target finding's claim, so it must pass the claim schema.
CLAIM = TypeAdapter(Annotated[str, FindingInput.model_fields["claim"]])


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


def slugify(title: str) -> str:
    """Port of slugify in src/topic.ts; test/fixtures/slugify.json keeps the two in sync."""
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", title.lower()))


def compose_target(finding_ids: list[str], direction: str) -> str:
    """The `-f` value: one id alone continues its focus; anything else is free text naming the ids."""
    direction = " ".join(direction.split())  # a claim is one line
    if len(finding_ids) == 1 and not direction:
        return finding_ids[0]
    builds_on = f"(builds on {', '.join(finding_ids)})" if finding_ids else ""
    return " ".join(p for p in (direction, builds_on) if p)


def claim_errors(target: str) -> list[str]:
    try:
        CLAIM.validate_python(target)
        return []
    except ValidationError as e:
        return [err["msg"] for err in e.errors()]


class SpawnError(Exception):
    def __init__(self, exit_code: int, output: str):
        super().__init__(f"bin/research exited with code {exit_code}")
        self.exit_code, self.output = exit_code, output


class Launcher:
    """Spawns detached bin/research runs. The CLI's topic lock is the real guard; `procs` only covers a child's startup.
    Also spawns bin/preprint, which takes no lock, so `preprints` is its only guard."""

    def __init__(self, root: Path, research: Path = RESEARCH, preprint: Path = PREPRINT, regen: Path = REGEN):
        self.root, self.research, self.preprint, self.regen = root, research, preprint, regen
        self.regens: dict[tuple[str, str], subprocess.Popen] = {}  # (slug, report name) -> last bin/regen-report child
        self.procs: dict[str, subprocess.Popen] = {}  # slug -> last child spawned for it
        self.preprints: dict[str, tuple[subprocess.Popen, Path]] = {}  # slug -> last pre-print child and its output .md
        self.mutex = threading.Lock()  # check-then-spawn is atomic across request threads

    def busy(self, slug: str) -> bool:
        """A live pid holds the lock, or our child has not exited yet (it may not have taken the lock)."""
        p = self.procs.get(slug)
        return lock_pid(self.root / slug) is not None or (p is not None and p.poll() is None)

    def spawn(
        self, slug: str, title: str, windows: int, concurrency: int, target: str | None = None, brief: str | None = None
    ) -> tuple[subprocess.Popen, Path]:
        """Start a run (call under `mutex`, after `busy`); returns the child and its output file for `settle`."""
        ui = self.root / ".ui"
        ui.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%S-%f")
        args = [str(self.research), "-t", title, "-n", str(windows), "-c", str(concurrency)]
        if target is not None:
            args += ["-f", target]
        if brief is not None:
            brief_path = ui / f"{slug}-{stamp}.brief.md"
            brief_path.write_text(brief)
            args += ["-b", str(brief_path)]
        proc, out = self.popen(args, ui / f"{slug}-{stamp}.out")
        self.procs[slug] = proc
        return proc, out

    def preprint_busy(self, slug: str) -> bool:
        p = self.preprints.get(slug)
        return p is not None and p[0].poll() is None

    def spawn_preprint(self, slug: str, title: str, finding_id: str, focus_key: str | None) -> tuple[subprocess.Popen, Path]:
        """Start bin/preprint (call under `mutex`, after `preprint_busy`); it may run alongside a research run."""
        ui = self.root / ".ui"
        ui.mkdir(parents=True, exist_ok=True)
        now = datetime.now(UTC)
        md = PREPRINTS / slug / f"pre-print-{now.strftime('%Y-%m-%dT%H%M%S')}.md"
        args = [str(self.preprint), "-t", title, "-f", finding_id, "-o", str(md)] + (["-k", focus_key] if focus_key else [])
        proc, out = self.popen(args, ui / f"{slug}-preprint-{now.strftime('%Y-%m-%dT%H-%M-%S-%f')}.out")
        self.preprints[slug] = (proc, md)
        return proc, out

    def preprint_status(self, slug: str) -> dict:
        """The last pre-print spawned for `slug` since the server started; path is relative to the repo."""
        p = self.preprints.get(slug)
        if p is None:
            return {"running": False, "exitCode": None, "path": None}
        proc, md = p
        code = proc.poll()
        return {"running": code is None, "exitCode": code, "path": str(md.relative_to(PREPRINTS.parent))}

    def regen_busy(self, slug: str, name: str) -> bool:
        p = self.regens.get((slug, name))
        return p is not None and p.poll() is None

    def spawn_regen(self, slug: str, title: str, name: str) -> tuple[subprocess.Popen, Path]:
        """Start bin/regen-report (call under `mutex`, after `regen_busy`); like a pre-print, it takes no topic lock."""
        ui = self.root / ".ui"
        ui.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%S-%f")
        proc, out = self.popen([str(self.regen), "-t", title, "-r", name], ui / f"{slug}-report-{stamp}.out")
        self.regens[(slug, name)] = proc
        return proc, out

    def regen_status(self, slug: str, name: str) -> dict:
        p = self.regens.get((slug, name))
        code = p.poll() if p else None
        return {"running": p is not None and code is None, "exitCode": code}

    @staticmethod
    def popen(args: list[str], out: Path) -> tuple[subprocess.Popen, Path]:
        with out.open("wb") as f:
            # New session: stopping the server (or Ctrl-C in its terminal) does not stop the run.
            proc = subprocess.Popen(
                args,
                cwd=REPO,
                env={**os.environ, "RESEARCH_ORIGIN": "ui"},
                stdin=subprocess.DEVNULL,
                stdout=f,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        return proc, out

    @staticmethod
    def settle(proc: subprocess.Popen, out: Path) -> int:
        """The child's pid once it outlives SPAWN_GRACE_S; SpawnError with its output if it exits first."""
        try:
            code = proc.wait(SPAWN_GRACE_S)
        except subprocess.TimeoutExpired:
            # Reap it when it ends: a zombie still answers kill(pid, 0), so it would look alive.
            threading.Thread(target=proc.wait, daemon=True).start()
            return proc.pid
        raise SpawnError(code, out.read_text(errors="replace")[-TAIL_CHARS:])

    def stop(self, slug: str) -> int | None:
        """SIGTERM the lock holder (the CLI records an end event with reason signal); None if not running."""
        pid = lock_pid(self.root / slug)
        if pid is None:
            return None
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return None
        return pid
