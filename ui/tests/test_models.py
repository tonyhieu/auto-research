import json

import pytest
from pydantic import TypeAdapter, ValidationError

from arui.models import Finding, FindingInput, FocusRecord, RunEnd, RunEvent, RunStart, Task, VerdictInput, Verification

PAPER = "a" * 40
FINDING_INPUT = {
    "kind": "insight",
    "title": "Weighting beats subsampling",
    "claim": "Diversity weighting beats uniform subsampling at equal budget.",
    "evidence": "| n | acc |\n|---|---|\n| 3 | 0.81 |\n\nSee the cited paper for the baseline.",
    "sources": [PAPER, "f-0123abcd"],
}
FINDING = {**FINDING_INPUT, "id": "f-89abcdef", "ts": "2026-11-09T03:18:22.920Z", "author": "sub-1", "status": "verified"}
VERDICT_INPUT = {"check": "citation", "verdict": "pass", "rationale": "The cited paper reports 0.81 accuracy in Table 2, as claimed."}
VERIFICATION = {**VERDICT_INPUT, "id": "v-01234567", "ts": "2026-11-09T04:00:00Z", "findingId": "f-89abcdef", "by": "verifier-1"}


def ok(model, data):
    """Validate as a ledger line (JSON), the way the harness and `arui validate` see it."""
    return model.model_validate_json(json.dumps(data))


def bad(model, data):
    with pytest.raises(ValidationError):
        ok(model, data)


def test_valid_records():
    ok(FindingInput, FINDING_INPUT)
    f = ok(Finding, {**FINDING, "taskId": "t-0052b457", "role": "focus-target"})
    assert f.experiment is None
    ok(Finding, {**FINDING, "experiment": {"setup": "x" * 40, "results": "y" * 20}})
    v = ok(VerdictInput, VERDICT_INPUT)
    assert v.sources == []
    ok(Verification, {**VERIFICATION, "sources": [PAPER], "focus": {"key": "fx-dd5cb212", "outcome": "holds_with_limits", "narrowedFindingId": "f-11111111"}})


@pytest.mark.parametrize(
    "field,value",
    [
        ("kind", "opinion"),
        ("title", "short"),
        ("title", "x" * 101),
        ("title", "Two\nlines here"),
        ("claim", "too short"),
        ("claim", "x" * 1001),
        ("claim", "A claim long enough\nbut on two lines"),
        ("evidence", "x" * 39),
        ("evidence", "x" * 4001),
        ("sources", []),
        ("sources", [PAPER] * 41),
        ("sources", ['["' + PAPER + '"]']),
        ("sources", [""]),
        ("sources", ["f-123"]),
        ("experiment", {"setup": "x" * 39, "results": "y" * 20}),
        ("experiment", {"setup": "x" * 40, "results": "y" * 19}),
        ("experiment", {"setup": "x" * 2501, "results": "y" * 20}),
        ("experiment", {"setup": "x" * 40}),
    ],
)
def test_finding_input_rejects(field, value):
    bad(FindingInput, {**FINDING_INPUT, field: value})


@pytest.mark.parametrize("source", [PAPER, "f-0123abcd", "arXiv:2401.00001", "DOI:10.1000/xyz", "CorpusId:123"])
def test_source_ids_accepted(source):
    ok(FindingInput, {**FINDING_INPUT, "sources": [source]})


def test_multiline_evidence_allowed():
    ok(FindingInput, {**FINDING_INPUT, "evidence": "line one of the evidence\n\n- bullet two\n- bullet three"})


def test_missing_title_rejected():
    bad(FindingInput, {k: v for k, v in FINDING_INPUT.items() if k != "title"})


def test_unknown_fields_rejected():
    bad(FindingInput, {**FINDING_INPUT, "novelty": "novel"})
    bad(Verification, {**VERIFICATION, "extra": 1})


@pytest.mark.parametrize(
    "field,value",
    [
        ("id", "f-123"),
        ("id", "v-01234567"),
        ("ts", "not a date"),
        ("ts", 1731122302),
        ("status", "pending"),
        ("role", "target"),
    ],
)
def test_finding_rejects(field, value):
    bad(Finding, {**FINDING, field: value})


@pytest.mark.parametrize(
    "field,value",
    [
        ("check", "style"),
        ("verdict", "maybe"),
        ("rationale", "x" * 39),
        ("rationale", "x" * 2001),
        ("sources", [PAPER] * 41),
        ("id", "f-01234567"),
        ("focus", {"key": "fx-123", "outcome": "holds"}),
        ("focus", {"key": "fx-dd5cb212", "outcome": "passes"}),
    ],
)
def test_verification_rejects(field, value):
    bad(Verification, {**VERIFICATION, field: value})


def test_server_models_parse_harness_shapes():
    Task.model_validate(
        {
            "id": "t-0052b457",
            "created": "2026-11-12T21:21:42.144Z",
            "title": "Re-verify",
            "description": "d",
            "status": "open",
            "type": "verify",
            "findingId": "f-ec843c86",
        }
    )
    FocusRecord.model_validate({"key": "fx-dd5cb212", "target": "f-ed14e8ea", "findingId": "f-ed14e8ea", "started": "2026-11-09T03:18:22.920Z"})
    events = TypeAdapter(RunEvent)
    start = events.validate_python(
        {
            "event": "start",
            "runId": "r-1a2b3c4d",
            "ts": "2026-11-09T03:18:22Z",
            "pid": 123,
            "mode": "focus",
            "focusKey": "fx-94f05870",
            "target": "f-ed14e8ea",
            "windows": 1,
            "concurrency": 3,
            "log": "logs/run-1.log",
            "origin": "ui",
        }
    )
    end = events.validate_python({"event": "end", "runId": "r-1a2b3c4d", "ts": "2026-11-09T04:00:00Z", "exitCode": 0, "reason": "complete", "findings": 312})
    assert isinstance(start, RunStart) and isinstance(end, RunEnd)
