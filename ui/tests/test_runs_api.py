import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_api import SLUG, topics  # noqa: F401 (fixture)

from arui import runs
from arui.runs import REPO, compose_target, slugify
from arui.server import create_app
from arui.store import Store

LOCAL = "http://127.0.0.1:8765"
# Records its argv and env, prints a line, then exits 2 (STUB_FAIL) or lingers like a real run.
STUB = f"""#!/bin/sh
{sys.executable} -c 'import json, os, sys; p = os.environ["STUB_LOG"]; open(p + ".tmp", "w").write(json.dumps({{"args": sys.argv[1:], "origin": os.environ.get("RESEARCH_ORIGIN"), "cwd": os.getcwd()}})); os.replace(p + ".tmp", p)' "$@"
echo "stub: usage error"
[ -n "$STUB_FAIL" ] && exit 2
exec sleep 5
"""


@pytest.fixture
def stub(tmp_path_factory, monkeypatch):
    d = tmp_path_factory.mktemp("stub")
    (d / "research").write_text(STUB)
    (d / "research").chmod(0o755)
    monkeypatch.setenv("STUB_LOG", str(d / "call.json"))
    monkeypatch.setattr(runs, "SPAWN_GRACE_S", 0.3)
    return d


@pytest.fixture
def app(topics, stub):  # noqa: F811
    app = create_app(Store(topics), research=stub / "research")
    yield app
    for p in app.state.launcher.procs.values():
        p.kill()


@pytest.fixture
def client(app):
    return TestClient(app, base_url=LOCAL)


def call(stub):
    """The stub's recorded call; it is written just after spawn, so poll for it."""
    path, deadline = stub / "call.json", time.time() + 5
    while not path.exists() and time.time() < deadline:
        time.sleep(0.02)
    return json.loads(path.read_text())


def test_slugify_matches_shared_fixture():
    for title, slug in json.loads((REPO / "test" / "fixtures" / "slugify.json").read_text()):
        assert slugify(title) == slug, title


def test_compose_target():
    assert compose_target(["f-00000001"], "") == "f-00000001"
    assert compose_target(["f-00000001"], " Try\nharder ") == "Try harder (builds on f-00000001)"
    assert compose_target(["f-00000001", "f-00000002"], "") == "(builds on f-00000001, f-00000002)"
    assert compose_target([], "only text") == "only text"
    assert compose_target([], "  ") == ""


def test_breadth_spawn(client, stub, topics):  # noqa: F811
    r = client.post(f"/api/topics/{SLUG}/runs", json={"mode": "breadth", "windows": 2, "concurrency": 1})
    assert r.status_code == 202 and r.json()["mode"] == "breadth" and r.json()["target"] is None
    c = call(stub)
    assert c["args"] == ["-t", "Demo Topic", "-n", "2", "-c", "1"]
    assert c["origin"] == "ui" and c["cwd"] == str(REPO)
    [out] = (topics / ".ui").glob(f"{SLUG}-*.out")
    assert "stub: usage error" in out.read_text()
    # Still starting (no lock yet), so a second start is refused rather than racing the CLI's lock.
    assert client.post(f"/api/topics/{SLUG}/runs", json={"mode": "breadth"}).status_code == 409


def test_breadth_rejects_focus_fields(client):
    for body in ({"findingIds": ["f-89abcdef"]}, {"direction": "go deeper"}):
        assert client.post(f"/api/topics/{SLUG}/runs", json={"mode": "breadth", **body}).status_code == 422


def test_focus_single_id(client, stub):
    r = client.post(f"/api/topics/{SLUG}/runs", json={"mode": "focus", "findingIds": ["f-89abcdef"]})
    assert r.status_code == 202 and r.json()["target"] == "f-89abcdef"
    assert call(stub)["args"][-2:] == ["-f", "f-89abcdef"]


def test_focus_free_text(client, stub):
    body = {"mode": "focus", "findingIds": ["f-89abcdef", "f-22222222"], "direction": "Test under class-conditional flips"}
    assert client.post(f"/api/topics/{SLUG}/runs", json=body).status_code == 202
    assert call(stub)["args"][-2:] == ["-f", "Test under class-conditional flips (builds on f-89abcdef, f-22222222)"]


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"direction": "   "},
        {"direction": "x" * 1001},
        {"direction": "too short"},
        {"findingIds": ["f-deadbeef"]},
        {"direction": " f-deadbeef "},
        {"findingIds": ["nope"], "direction": "a direction that is long enough"},
        {"direction": "a direction that is long enough", "windows": 0},
    ],
)
def test_focus_rejects(client, stub, body):
    assert client.post(f"/api/topics/{SLUG}/runs", json={"mode": "focus", **body}).status_code == 422
    assert not (stub / "call.json").exists()


def test_running_topic_conflicts(client, topics):  # noqa: F811
    (topics / SLUG / ".lock").write_text(str(os.getpid()))
    assert client.post(f"/api/topics/{SLUG}/runs", json={"mode": "breadth"}).status_code == 409


def test_early_exit_returns_output(client, monkeypatch):
    monkeypatch.setenv("STUB_FAIL", "1")
    r = client.post(f"/api/topics/{SLUG}/runs", json={"mode": "breadth"})
    assert r.status_code == 500
    d = r.json()["detail"]
    assert d["exitCode"] == 2 and "stub: usage error" in d["output"]
    assert client.post(f"/api/topics/{SLUG}/runs", json={"mode": "breadth"}).status_code == 500, "a failed child does not block"


def test_unknown_topic(client):
    assert client.post("/api/topics/nope/runs", json={"mode": "breadth"}).status_code == 404
    assert client.post("/api/topics/nope/stop", json={}).status_code == 404


def test_new_topic(client, stub, topics):  # noqa: F811
    r = client.post("/api/topics", json={"title": "  Label Noise: Flips!  ", "brief": "  # Goals\n\nFind gaps.\n", "concurrency": 2})
    assert r.status_code == 202 and r.json()["slug"] == "label-noise-flips"
    args = call(stub)["args"]
    assert args[:6] == ["-t", "Label Noise: Flips!", "-n", "1", "-c", "2"] and args[6] == "-b"
    assert args[7].startswith(str(topics / ".ui" / "label-noise-flips-")) and Path(args[7]).read_text() == "# Goals\n\nFind gaps."
    assert client.post("/api/topics", json={"title": "label noise flips"}).status_code == 409, "still starting"


def test_new_topic_without_brief(client, stub):
    assert client.post("/api/topics", json={"title": "Fresh topic"}).status_code == 202
    assert "-b" not in call(stub)["args"]


def test_new_topic_rejects(client, stub):
    r = client.post("/api/topics", json={"title": "Demo"})
    assert r.status_code == 409 and r.json()["detail"]["slug"] == SLUG
    assert client.post("/api/topics", json={"title": "!!!"}).status_code == 422
    assert client.post("/api/topics", json={"title": "two\nlines"}).status_code == 422
    assert client.post("/api/topics", json={"title": "Big brief", "brief": "x" * (runs.BRIEF_CAP + 1)}).status_code == 422
    assert not (stub / "call.json").exists()


def test_stop(client, topics):  # noqa: F811
    assert client.post(f"/api/topics/{SLUG}/stop", json={}).status_code == 404
    sleeper = subprocess.Popen(["sleep", "30"])
    try:
        (topics / SLUG / ".lock").write_text(str(sleeper.pid))
        r = client.post(f"/api/topics/{SLUG}/stop", json={})
        assert r.status_code == 202 and r.json() == {"pid": sleeper.pid}
        assert sleeper.wait(5) == -signal.SIGTERM
    finally:
        sleeper.kill()


def test_local_safety(client, stub):
    url, body = f"/api/topics/{SLUG}/runs", {"mode": "breadth"}
    assert client.post(url, content=json.dumps(body), headers={"Content-Type": "text/plain"}).status_code == 415
    assert client.post(url, json=body, headers={"Host": "evil.example:8765"}).status_code == 403
    assert client.post(url, json=body, headers={"Origin": "http://evil.example"}).status_code == 403
    assert TestClient(client.app).post(url, json=body).status_code == 403, "Host testserver"
    assert not (stub / "call.json").exists()
    assert client.post(url, json=body, headers={"Origin": "http://localhost:8765", "Host": "localhost:8765"}).status_code == 202


def test_render_preview(client):
    r = client.post("/api/render", json={"md": "# Goals\n\n<b>x</b> | a |\n"})
    assert r.status_code == 200 and "<h1>Goals</h1>" in r.json()["html"] and "&lt;b&gt;" in r.json()["html"]


def test_spawned_run_is_detached_and_reaped(app, client):
    assert client.post(f"/api/topics/{SLUG}/runs", json={"mode": "breadth"}).status_code == 202
    proc = app.state.launcher.procs[SLUG]
    assert os.getpgid(proc.pid) == proc.pid, "own session, so the server's signals do not reach it"
    proc.kill()
    deadline = time.time() + 5
    while proc.returncode is None and time.time() < deadline:
        time.sleep(0.05)
    assert proc.returncode is not None, "the reaper thread waited on it"


def test_grace_wait_does_not_hold_the_mutex(app, client, monkeypatch):
    monkeypatch.setattr(runs, "SPAWN_GRACE_S", 1.5)
    t = threading.Thread(target=lambda: client.post(f"/api/topics/{SLUG}/runs", json={"mode": "breadth"}))
    t.start()
    while SLUG not in app.state.launcher.procs:
        time.sleep(0.02)
    assert app.state.launcher.mutex.acquire(timeout=0.5), "another topic could start meanwhile"
    app.state.launcher.mutex.release()
    t.join()
