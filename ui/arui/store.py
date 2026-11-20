"""Load and derive a topic from topics/<slug>/, cached until one of its files changes."""

import re
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import BaseModel, ValidationError

from arui.derive import Effective, apply_verifications, bucket, latest_verdicts
from arui.models import Finding, Paper, Task, TopicMeta, Verification
from arui.render import LinkContext, rendered

DOC_NAME = re.compile(r"^[A-Za-z0-9._-]+\.md$")
DOC_GROUPS = ("notes", "reports", "state", "brief")
FINDING_ID = re.compile(r"^f-[0-9a-f]{8}$")


def read_jsonl[M: BaseModel](path: Path, model: type[M]) -> tuple[list[M], int]:
    """Valid records and the count of invalid lines (e.g. truncated by a crash, or un-migrated)."""
    if not path.exists():
        return [], 0
    ok, bad = [], 0
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            ok.append(model.model_validate_json(line))
        except ValidationError:
            bad += 1
    return ok, bad


def is_doc(group: str, name: str) -> bool:
    """Doc names the API serves; no path traversal, and focus states only (no .prev.md)."""
    if group == "brief":
        return name == "brief.md"
    if group not in DOC_GROUPS or not DOC_NAME.match(name):
        return False
    return group != "state" or (name.startswith("focus-") and not name.endswith(".prev.md"))


def doc_dir(topic: Path, group: str) -> Path:
    return topic if group == "brief" else topic / group


def mtime(p: Path) -> tuple[int, int]:
    """(mtime, size), so an append within the clock's resolution still changes the signature."""
    try:
        st = p.stat()
        return st.st_mtime_ns, st.st_size
    except OSError:
        return 0, 0


def signature(topic: Path) -> tuple:
    """Changes when any input file changes; tasks are rewritten in place, so directory mtimes alone miss edits."""
    files = [topic / n for n in ("ledger.jsonl", "verifications.jsonl", "papers.jsonl", "topic.json")]
    dirs = [topic / n for n in ("tasks", "state", "notes")]
    return tuple(mtime(f) for f in files) + tuple((c.name, mtime(c)) for d in dirs for c in sorted(d.glob("*")))


@dataclass
class Topic:
    slug: str
    dir: Path
    title: str
    findings: dict[str, Finding]
    verifications: list[Verification]
    invalid_lines: int
    effective: dict[str, Effective]
    latest: dict[str, dict[str, Verification]]
    tasks: dict[str, Task]
    papers: dict[str, Paper]
    referenced_by: dict[str, list[str]]
    links: LinkContext
    orchestrator: str
    _html: dict[tuple, dict] = field(default_factory=dict)

    def md(self, key: tuple, text: str, inline: bool = False) -> dict[str, str]:
        """Rendered `{md, html}`, cached per record field; the whole Topic is rebuilt when files change."""
        if key not in self._html:
            self._html[key] = rendered(text, self.links, inline)
        return self._html[key]

    def bucket(self, fid: str) -> str:
        return bucket(self.effective[fid])

    def counts(self) -> dict[str, int]:
        c = {"main": 0, "refuted": 0, "known": 0, "pending": 0}
        for fid in self.findings:
            c[self.bucket(fid)] += 1
        return {**c, "total": len(self.findings)}


def topic_title(topic: Path, orchestrator: str) -> str:
    """topic.json, else the orchestrator state header (`# Orchestrator state: <title>`), else the slug."""
    try:
        return TopicMeta.model_validate_json((topic / "topic.json").read_text()).title
    except (OSError, ValidationError):
        pass
    first = orchestrator.split("\n", 1)[0]
    prefix = "# Orchestrator state: "
    return first[len(prefix) :].strip() if first.startswith(prefix) else topic.name


def load_topic(topic: Path) -> Topic:
    findings, bad_f = read_jsonl(topic / "ledger.jsonl", Finding)
    vs, bad_v = read_jsonl(topic / "verifications.jsonl", Verification)
    tasks = {}
    for p in sorted((topic / "tasks").glob("*.json")):
        try:
            t = Task.model_validate_json(p.read_text())
            tasks[t.id] = t
        except (OSError, ValidationError):
            pass
    papers = {p.paperId: p for p in read_jsonl(topic / "papers.jsonl", Paper)[0]}  # last line per id wins
    referenced_by: dict[str, list[str]] = {}
    for f in findings:
        for s in dict.fromkeys(f.sources):
            if FINDING_ID.match(s):
                referenced_by.setdefault(s, []).append(f.id)
    orch = topic / "state" / "orchestrator.md"
    orchestrator = orch.read_text() if orch.exists() else ""
    eff = apply_verifications(findings, vs)
    links = LinkContext(
        findings={f.id for f in findings},
        notes={p.stem for p in (topic / "notes").glob("*.md")},
        focus={p.stem.removeprefix("focus-") for p in (topic / "state").glob("focus-*.md") if is_doc("state", p.name)},
        papers={pid: p.title for pid, p in papers.items() if p.title},
        status={fid: e.status for fid, e in eff.items()},
    )
    return Topic(
        slug=topic.name,
        dir=topic,
        title=topic_title(topic, orchestrator),
        findings={f.id: f for f in findings},
        verifications=vs,
        invalid_lines=bad_f + bad_v,
        effective=eff,
        latest=latest_verdicts(vs),
        tasks=tasks,
        papers=papers,
        referenced_by=referenced_by,
        links=links,
        orchestrator=orchestrator,
    )


class Store:
    def __init__(self, root: Path):
        self.root = root
        self._cache: dict[str, tuple[tuple, Topic]] = {}

    def slugs(self) -> list[str]:
        """Topic dirs with a ledger; skips topics/.ui and anything else without one."""
        if not self.root.is_dir():
            return []
        return sorted(d.name for d in self.root.iterdir() if d.is_dir() and (d / "ledger.jsonl").is_file())

    def get(self, slug: str) -> Topic | None:
        if slug not in self.slugs():
            return None
        topic = self.root / slug
        sig = signature(topic)
        hit = self._cache.get(slug)
        if hit and hit[0] == sig:
            return hit[1]
        t = load_topic(topic)
        self._cache[slug] = (sig, t)
        return t


def list_docs(topic: Path) -> list[dict]:
    docs = []
    for group in DOC_GROUPS:
        d = doc_dir(topic, group)
        for p in sorted(d.glob("*.md")) if d.is_dir() else []:
            if is_doc(group, p.name):
                docs.append({"group": group, "name": p.name, "mtime": p.stat().st_mtime})
    return docs


def read_doc(topic: Path, group: str, name: str) -> str | None:
    if not is_doc(group, name):
        return None
    p = doc_dir(topic, group) / name
    return p.read_text() if p.is_file() else None
