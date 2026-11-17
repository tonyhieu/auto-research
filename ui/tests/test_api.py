import json
import os

import pytest
from fastapi.testclient import TestClient
from test_models import FINDING, PAPER, VERIFICATION

from arui.server import create_app
from arui.store import Store

SLUG = "demo"
F2 = {**FINDING, "id": "f-22222222", "title": "Second finding title", "sources": ["f-89abcdef", "f-deadbeef"], "taskId": "t-00000001"}
F2["experiment"] = {"setup": "Seeds 0-4, n=200, logistic regression on the cached embeddings.", "results": "| seed | acc |\n|---|---|\n| 0 | 0.8 |"}


def v(i, fid, check, verdict, ts, **kw):
    return {**VERIFICATION, "id": f"v-{i:08x}", "findingId": fid, "check": check, "verdict": verdict, "ts": ts, **kw}


def jsonl(*records):
    return "".join(json.dumps(r) + "\n" for r in records)


@pytest.fixture
def topics(tmp_path):
    t = tmp_path / SLUG
    for d in ("tasks", "notes", "reports", "state"):
        (t / d).mkdir(parents=True)
    (t / "ledger.jsonl").write_text(jsonl(FINDING, F2) + '{"id":"f-legacy","claim":"old"}\n{trunc')
    (t / "verifications.jsonl").write_text(
        jsonl(
            v(1, "f-89abcdef", "citation", "pass", "2026-11-09T04:00:00Z"),
            v(2, "f-89abcdef", "adversarial", "fail", "2026-11-09T04:01:00Z"),
            v(3, "f-89abcdef", "adversarial", "pass", "2026-11-09T04:02:00Z"),
            v(4, "f-89abcdef", "novelty", "pass", "2026-11-09T04:03:00Z"),
            v(5, "f-22222222", "citation", "fail", "2026-11-09T04:04:00Z"),
        )
    )
    (t / "topic.json").write_text(json.dumps({"slug": SLUG, "title": "Demo Topic", "created": "2026-11-01T00:00:00Z"}))
    (t / "papers.jsonl").write_text(jsonl({"paperId": PAPER, "title": "Old title"}, {"paperId": PAPER, "title": "Paper Title", "year": 2024}))
    (t / "tasks" / "t-00000001.json").write_text(
        json.dumps({"id": "t-00000001", "created": "2026-11-01T00:00:00Z", "title": "Look into it", "description": "d", "status": "done"})
    )
    (t / "notes" / "t-00000001.md").write_text("# Note\n\nAbout f-89abcdef.")
    (t / "reports" / "r1.md").write_text("report")
    (t / "reports" / "r1.html").write_text("<p>report</p>")
    (t / "brief.md").write_text("brief")
    (t / "state" / "orchestrator.md").write_text("# Orchestrator state: Demo Topic\n\n## Status: exploring weighting\n")
    (t / "state" / "focus-fx-00000001.md").write_text("# Focus state")
    (t / "state" / "focus-fx-00000001.prev.md").write_text("old")
    (tmp_path / ".ui").mkdir()  # server's own dir; no ledger, so not a topic
    return tmp_path


@pytest.fixture
def client(topics):
    return TestClient(create_app(Store(topics)))


def test_topic_list(client):
    [t] = client.get("/api/topics").json()
    assert t["slug"] == SLUG and t["title"] == "Demo Topic"
    assert t["counts"] == {"main": 1, "refuted": 1, "known": 0, "pending": 0, "total": 2}
    assert t["invalidLines"] == 2
    assert t["run"] == {"state": "idle", "last": None}


def test_topic_view(client):
    t = client.get(f"/api/topics/{SLUG}").json()
    rows = {r["id"]: r for r in t["findings"]}
    assert rows["f-89abcdef"]["bucket"] == "main" and rows["f-89abcdef"]["status"] == "verified"
    assert rows["f-89abcdef"]["checks"] == {"citation": "pass", "adversarial": "pass", "reproduce": None, "novelty": "pass"}
    assert rows["f-22222222"]["bucket"] == "refuted"
    assert rows["f-22222222"]["title"] == {"md": "Second finding title", "html": "Second finding title"}
    assert t["mainHypothesis"]["focusKey"] is None and "exploring weighting" in t["mainHypothesis"]["claim"]["html"]


def test_main_hypothesis_from_focus_outcome(client, topics):
    focus = {"key": "fx-00000001", "outcome": "holds_with_limits", "narrowedFindingId": "f-22222222"}
    with open(topics / SLUG / "verifications.jsonl", "a") as f:
        f.write(jsonl(v(6, "f-89abcdef", "adversarial", "pass", "2026-11-10T00:00:00Z", focus=focus)))
    m = client.get(f"/api/topics/{SLUG}").json()["mainHypothesis"]
    assert m["findingId"] == "f-22222222" and m["focusKey"] == "fx-00000001" and m["outcome"] == "holds_with_limits"
    assert m["claim"]["md"] == F2["claim"]


def test_finding_detail(client):
    d = client.get(f"/api/topics/{SLUG}/findings/f-22222222").json()
    assert d["task"] == {"id": "t-00000001", "title": "Look into it", "notePath": "notes/t-00000001.md"}
    assert d["references"] == [{"id": "f-89abcdef", "removed": False}, {"id": "f-deadbeef", "removed": True}]
    assert d["papers"] == []
    assert "<table>" in d["experiment"]["results"]["html"]
    d = client.get(f"/api/topics/{SLUG}/findings/f-89abcdef").json()
    assert d["referencedBy"] == ["f-22222222"]
    assert d["papers"] == [{"id": PAPER, "title": "Paper Title", "year": 2024}]
    assert [x["id"] for x in d["verifications"]] == ["v-00000004", "v-00000003", "v-00000002", "v-00000001"]
    assert [x["superseded"] for x in d["verifications"]] == [False, False, True, False]
    assert d["task"] is None and d["experiment"] is None
    assert client.get(f"/api/topics/{SLUG}/findings/f-00000000").status_code == 404


def test_docs(client):
    docs = client.get(f"/api/topics/{SLUG}/docs").json()
    assert [(d["group"], d["name"]) for d in docs] == [
        ("notes", "t-00000001.md"),
        ("reports", "r1.md"),
        ("state", "focus-fx-00000001.md"),
        ("brief", "brief.md"),
    ]
    note = client.get(f"/api/topics/{SLUG}/docs/notes/t-00000001.md").json()
    assert note["md"].startswith("# Note") and 'data-finding="f-89abcdef"' in note["html"]
    for path in (
        "state/orchestrator.md",
        "state/focus-fx-00000001.prev.md",
        "reports/r1.html",
        "notes/..%2Fbrief.md",
        "brief/other.md",
        "tasks/t-00000001.json",
    ):
        assert client.get(f"/api/topics/{SLUG}/docs/{path}").status_code == 404, path


def test_unknown_topic(client):
    assert client.get("/api/topics/.ui").status_code == 404
    assert client.get("/api/topics/nope/docs").status_code == 404


def test_runs_fold_and_status(client, topics):
    t = topics / SLUG
    start = {"event": "start", "ts": "2026-11-09T00:00:00Z", "mode": "breadth", "windows": 1, "concurrency": 3, "log": "logs/x.log", "origin": "cli"}
    (t / "state" / "runs.jsonl").write_text(
        jsonl(
            {**start, "runId": "r-00000001", "pid": 999999999},
            {"event": "end", "runId": "r-00000001", "ts": "2026-11-09T01:00:00Z", "exitCode": 0, "reason": "complete", "findings": 2},
            {**start, "runId": "r-00000002", "pid": 999999998},
            {**start, "runId": "r-00000003", "pid": os.getpid(), "mode": "focus", "focusKey": "fx-00000001"},
        )
        + "{trunc"
    )
    runs = client.get(f"/api/topics/{SLUG}/runs").json()
    assert [(r["runId"], r["reason"]) for r in runs] == [("r-00000003", "lost"), ("r-00000002", "lost"), ("r-00000001", "complete")]
    assert client.get("/api/topics").json()[0]["run"]["last"]["runId"] == "r-00000003"
    (t / ".lock").write_text(str(os.getpid()))
    runs = client.get(f"/api/topics/{SLUG}/runs").json()
    assert runs[0]["reason"] is None and runs[0]["running"] and runs[1]["reason"] == "lost"
    run = client.get("/api/topics").json()[0]["run"]
    assert run["state"] == "running" and run["pid"] == os.getpid() and run["start"]["focusKey"] == "fx-00000001"


def test_reloads_after_append(client, topics):
    assert client.get(f"/api/topics/{SLUG}").json()["counts"]["total"] == 2
    with open(topics / SLUG / "ledger.jsonl", "a") as f:
        f.write("\n" + jsonl({**FINDING, "id": "f-33333333"}))
    assert client.get(f"/api/topics/{SLUG}").json()["counts"]["total"] == 3


def test_serves_static_app(client):
    r = client.get("/")
    assert r.status_code == 200 and '<script type="module" src="/app.js">' in r.text
    assert "javascript" in client.get("/app.js").headers["content-type"]
    assert client.get("/app.css").status_code == 200
    assert client.get("/api/topics").status_code == 200
    assert client.get("/api/nope").status_code == 404  # not index.html
