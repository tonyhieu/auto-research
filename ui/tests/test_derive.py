import json
from pathlib import Path

from arui.derive import apply_verifications, bucket, checks, latest_focus, latest_verdicts, orchestrator_heading, superseded
from arui.models import Finding, Verification

FIXTURE = json.loads((Path(__file__).resolve().parents[2] / "test" / "fixtures" / "derivation.json").read_text())
FINDINGS = [Finding.model_validate_json(json.dumps(f)) for f in FIXTURE["findings"]]
VERIFICATIONS = [Verification.model_validate_json(json.dumps(v)) for v in FIXTURE["verifications"]]


def test_matches_shared_fixture():
    got = {fid: {"status": e.status, "novelty": e.novelty} for fid, e in apply_verifications(FINDINGS, VERIFICATIONS).items()}
    assert got == FIXTURE["expected"]


def test_buckets():
    eff = apply_verifications(FINDINGS, VERIFICATIONS)
    assert {fid: bucket(e) for fid, e in eff.items()} == {
        "f-00000001": "pending",
        "f-00000002": "main",
        "f-00000003": "refuted",
        "f-00000004": "refuted",
        "f-00000005": "known",
        "f-00000006": "pending",
        "f-00000007": "pending",
        "f-00000008": "main",
        "f-00000009": "pending",
        "f-0000000a": "refuted",
    }


def test_checks_and_superseded():
    latest = latest_verdicts(VERIFICATIONS)
    by_id = {f.id: f for f in FINDINGS}
    assert checks(by_id["f-00000007"], latest.get("f-00000007")) == {"citation": "pass", "adversarial": "pass", "reproduce": None, "novelty": None}
    assert "reproduce" not in checks(by_id["f-00000005"], latest.get("f-00000005")), "gaps have no reproduce chip"
    assert checks(by_id["f-00000001"], None) == {"citation": None, "adversarial": None, "reproduce": None, "novelty": None}
    adv7 = [v for v in VERIFICATIONS if v.findingId == "f-00000007" and v.check == "adversarial"]
    assert [superseded(v, latest) for v in adv7] == [False, True], "the later-ts pass wins over the later-written fail"


def test_latest_focus_and_heading():
    assert latest_focus(VERIFICATIONS) is None
    focused = [v.model_copy(update={"focus": {"key": "fx-0000000" + str(i), "outcome": "holds"}}) for i, v in enumerate(VERIFICATIONS[:2])]
    assert latest_focus(VERIFICATIONS + focused) is focused[1]
    assert orchestrator_heading("# Orchestrator state: X\n\n## Status: done\n## Map") == "Status: done"
    assert orchestrator_heading("# only a title\n") is None


def test_citation_changes_compare_status_at_write_time():
    from datetime import UTC, datetime

    from arui.derive import citation_changes

    by_id = {f.id: f for f in FINDINGS}
    now = apply_verifications(FINDINGS, VERIFICATIONS)
    text = " ".join([*by_id, "f-deadbeef", next(iter(by_id))])
    later = citation_changes(text, datetime(2100, 1, 1, tzinfo=UTC), by_id, VERIFICATIONS, now)
    assert later == {"cited": len(by_id) + 1, "deleted": ["f-deadbeef"], "changed": [], "stale": True}, "only the deletion"
    early = citation_changes(text, datetime(2000, 1, 1, tzinfo=UTC), by_id, VERIFICATIONS, now)
    moved = {fid for fid, e in now.items() if (e.status, e.novelty) != (by_id[fid].status, None)}
    assert {c["id"] for c in early["changed"]} == moved and moved, "before any verdict, status is as written"
    assert citation_changes("no ids", datetime(2000, 1, 1, tzinfo=UTC), by_id, VERIFICATIONS, now)["stale"] is False
