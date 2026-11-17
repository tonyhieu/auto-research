"""Ledger record formats. Source of truth for schema/*.schema.json, which the harness validates writes against."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

# Write constraints must be expressible in JSON Schema (no custom validators), so the export matches.
SourceId = Annotated[str, Field(pattern=r"^(f-[0-9a-f]{8}|[0-9a-f]{40}|arXiv:\S+|DOI:\S+|CorpusId:\d+)$")]
OneLine = r"^[^\n]+$"
# Strict so Pydantic rejects unix-number timestamps, which the exported schema (type string) also rejects.
Timestamp = Annotated[datetime, Field(strict=True)]


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Experiment(Record):
    setup: str = Field(min_length=40, max_length=2500, description="Markdown. Data, model, parameters, seeds: enough to rerun without the author's files.")
    results: str = Field(min_length=20, max_length=2500, description="Markdown. Numbers, preferably a table; state n/seeds and spread.")


class FindingInput(Record):  # ledger_add parameters
    kind: Literal["literature", "gap", "insight"]
    title: str = Field(min_length=8, max_length=100, pattern=OneLine, description="Short headline shown in lists.")
    claim: str = Field(min_length=20, max_length=1000, pattern=OneLine, description="One atomic, checkable claim.")
    evidence: str = Field(min_length=40, max_length=4000, description="Markdown. Why the sources support the claim.")
    experiment: Experiment | None = Field(None, description="Optional. Setup and results of a computation the finding rests on.")
    sources: list[SourceId] = Field(min_length=1, max_length=40)


class Finding(FindingInput):  # one ledger.jsonl line
    id: str = Field(pattern=r"^f-[0-9a-f]{8}$")
    ts: Timestamp
    author: str
    taskId: str | None = None
    status: Literal["unverified", "verified", "refuted"]
    role: Literal["focus-target"] | None = None


class FocusOutcome(Record):
    key: str = Field(pattern=r"^fx-[0-9a-f]{8}$")
    outcome: Literal["holds", "holds_with_limits", "fails"]
    narrowedFindingId: str | None = None


class VerdictInput(Record):  # verify_record parameters
    check: Literal["citation", "adversarial", "novelty", "reproduce"]
    verdict: Literal["pass", "fail", "inconclusive"]
    rationale: str = Field(min_length=40, max_length=2000, description="Markdown. Quotes, counterexamples, computation results, queries run.")
    sources: list[SourceId] = Field(default_factory=list, max_length=40)


class Verification(VerdictInput):  # one verifications.jsonl line
    id: str = Field(pattern=r"^v-[0-9a-f]{8}$")
    ts: Timestamp
    findingId: str
    by: str
    focus: FocusOutcome | None = None  # set only by focus_verdict


# Read by the server only (not enforced on write), so unknown fields are ignored.


class Task(BaseModel):  # tasks/<id>.json
    id: str
    created: datetime
    title: str
    description: str
    status: Literal["open", "claimed", "done"]
    type: Literal["research", "verify"] | None = None
    findingId: str | None = None
    addresses: list[str] = []
    assignee: str | None = None
    focus: str | None = None
    notes: list[str] = []
    retries: int = 0


class FocusRecord(BaseModel):  # one entry of state/focus.json
    key: str
    target: str
    findingId: str | None = None
    started: datetime


class EpochRecord(BaseModel):  # one state/epochs.jsonl line
    epoch: int
    ts: datetime
    tasksCreated: int
    stateUpdated: bool
    interrupted: str | None = None
    focus: str | None = None


class RunStart(BaseModel):  # state/runs.jsonl
    event: Literal["start"]
    runId: str
    ts: datetime
    pid: int
    mode: Literal["breadth", "focus"]
    focusKey: str | None = None
    target: str | None = None
    windows: int
    concurrency: int
    log: str
    origin: Literal["cli", "ui"]


class RunEnd(BaseModel):  # state/runs.jsonl
    event: Literal["end"]
    runId: str
    ts: datetime
    exitCode: int
    reason: Literal["complete", "signal", "error"]
    findings: int


RunEvent = Annotated[RunStart | RunEnd, Field(discriminator="event")]


class Paper(BaseModel):  # one papers.jsonl line
    paperId: str
    title: str | None = None
    year: int | None = None
    venue: str | None = None
    authors: list[str] = []


class TopicMeta(BaseModel):  # topic.json
    slug: str
    title: str
    created: datetime
