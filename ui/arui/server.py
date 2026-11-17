"""JSON API over topics/<slug>/ ledgers (read-only) and run control, plus the static app in ui/static/."""

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from arui import runs
from arui.derive import checks, latest_focus, orchestrator_heading, superseded
from arui.events import Events
from arui.models import OneLine
from arui.render import rendered
from arui.store import FINDING_ID, Store, Topic, list_docs, read_doc

STATIC = Path(__file__).resolve().parents[1] / "static"
LOCAL_HOSTS = {"localhost", "127.0.0.1"}


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RunRequest(Body):
    mode: Literal["breadth", "focus"]
    findingIds: list[str] = []
    direction: str = ""
    windows: int = Field(1, ge=1)
    concurrency: int = Field(3, ge=1)


class TopicRequest(Body):
    title: str = Field(min_length=1, max_length=200, pattern=OneLine)
    brief: str = ""
    windows: int = Field(1, ge=1)
    concurrency: int = Field(3, ge=1)


class RenderRequest(Body):
    md: str = Field(max_length=runs.BRIEF_CAP * 2)


def local_json(request: Request) -> None:
    """POST guard: JSON only (no CORS-simple form posts) from a localhost Host/Origin (no DNS rebinding)."""
    if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
        raise HTTPException(415, "Content-Type must be application/json")
    if urlsplit(f"//{request.headers.get('host', '')}").hostname not in LOCAL_HOSTS:
        raise HTTPException(403, "Host must be localhost or 127.0.0.1")
    origin = request.headers.get("origin")
    if origin is not None and urlsplit(origin).hostname not in LOCAL_HOSTS:
        raise HTTPException(403, "Origin must be localhost or 127.0.0.1")


def settle_or_500(proc, out: Path) -> int:
    """Waits out the grace period outside `launcher.mutex`, so starts on other topics are not held up."""
    try:
        return runs.Launcher.settle(proc, out)
    except runs.SpawnError as e:
        raise HTTPException(500, {"error": str(e), "exitCode": e.exit_code, "output": e.output}) from e


def topic_summary(t: Topic) -> dict:
    return {"slug": t.slug, "title": t.title, "counts": t.counts(), "run": runs.status(t.dir), "invalidLines": t.invalid_lines}


def finding_row(t: Topic, fid: str) -> dict:
    f, e = t.findings[fid], t.effective[fid]
    return {
        "id": f.id,
        "title": t.md((fid, "title"), f.title, inline=True),
        "claim": t.md((fid, "claim-inline"), f.claim, inline=True),
        "kind": f.kind,
        "ts": f.ts,
        "status": e.status,
        "novelty": e.novelty,
        "bucket": t.bucket(fid),
        "checks": checks(f, t.latest.get(fid)),
    }


def main_hypothesis(t: Topic) -> dict | None:
    """Latest focus outcome (narrowed claim if any, else the target's), else the orchestrator's first `##` heading."""
    v = latest_focus(t.verifications)
    if v and v.focus:
        fid = v.focus.narrowedFindingId if v.focus.narrowedFindingId in t.findings else v.findingId
        f = t.findings.get(fid)
        if f:
            return {
                "findingId": fid,
                "claim": t.md((fid, "claim"), f.claim),
                "focusKey": v.focus.key,
                "outcome": v.focus.outcome,
                "ts": v.ts,
            }
    heading = orchestrator_heading(t.orchestrator)
    if heading:
        return {"findingId": None, "claim": t.md(("orchestrator", "heading"), heading), "focusKey": None, "outcome": None, "ts": None}
    return None


def finding_detail(t: Topic, fid: str) -> dict:
    f = t.findings[fid]
    task = t.tasks.get(f.taskId or "")
    vs = sorted((v for v in t.verifications if v.findingId == fid), key=lambda v: v.ts, reverse=True)
    return {
        **finding_row(t, fid),
        "author": f.author,
        "role": f.role,
        "task": f.taskId and {"id": f.taskId, "title": task.title if task else None, "notePath": f"notes/{f.taskId}.md" if f.taskId in t.links.notes else None},
        "claim": t.md((fid, "claim"), f.claim),
        "evidence": t.md((fid, "evidence"), f.evidence),
        "experiment": f.experiment and {"setup": t.md((fid, "setup"), f.experiment.setup), "results": t.md((fid, "results"), f.experiment.results)},
        "verifications": [
            {
                "id": v.id,
                "ts": v.ts,
                "check": v.check,
                "verdict": v.verdict,
                "by": v.by,
                "superseded": superseded(v, t.latest),
                "rationale": t.md((v.id, "rationale"), v.rationale),
                "sources": v.sources,
                "focus": v.focus,
            }
            for v in vs
        ],
        "papers": [{"id": s, "title": (p := t.papers.get(s)) and p.title, "year": p and p.year} for s in dict.fromkeys(f.sources) if not s.startswith("f-")],
        "references": [{"id": s, "removed": s not in t.findings} for s in dict.fromkeys(f.sources) if s.startswith("f-")],
        "referencedBy": t.referenced_by.get(fid, []),
    }


def create_app(store: Store, research: Path = runs.RESEARCH) -> FastAPI:
    events = Events(store.root)
    launcher = runs.Launcher(store.root, research)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # Lifespan only runs under a server (or `with TestClient`), so plain API tests start no watcher.
        task = asyncio.create_task(events.watch())
        yield
        task.cancel()

    app = FastAPI(title="arui", lifespan=lifespan)
    app.state.events = events
    app.state.launcher = launcher

    def topic(slug: str) -> Topic:
        t = store.get(slug)
        if t is None:
            raise HTTPException(404, f"no topic {slug}")
        return t

    @app.get("/api/topics")
    def topics():
        return [topic_summary(t) for s in store.slugs() if (t := store.get(s))]

    @app.get("/api/topics/{slug}")
    def topic_view(slug: str):
        t = topic(slug)
        return {**topic_summary(t), "mainHypothesis": main_hypothesis(t), "findings": [finding_row(t, fid) for fid in t.findings]}

    @app.get("/api/topics/{slug}/findings/{fid}")
    def finding(slug: str, fid: str):
        t = topic(slug)
        if fid not in t.findings:
            raise HTTPException(404, f"no finding {fid}")
        return finding_detail(t, fid)

    @app.get("/api/topics/{slug}/docs")
    def docs(slug: str):
        return list_docs(topic(slug).dir)

    @app.get("/api/topics/{slug}/docs/{group}/{name}")
    def doc(slug: str, group: str, name: str):
        t = topic(slug)
        text = read_doc(t.dir, group, name)
        if text is None:
            raise HTTPException(404, f"no doc {group}/{name}")
        # reports/ and brief.md are not in the topic signature, so docs render fresh; they are read one at a time.
        return {"group": group, "name": name, **rendered(text, t.links)}

    @app.get("/api/topics/{slug}/runs")
    def run_list(slug: str):
        t = topic(slug)
        return runs.fold(runs.read_events(t.dir), runs.lock_pid(t.dir))

    @app.post("/api/topics/{slug}/runs", status_code=202, dependencies=[Depends(local_json)])
    def run_start(slug: str, body: RunRequest):
        t = topic(slug)
        target = None
        if body.mode == "breadth":
            if body.findingIds or body.direction.strip():
                raise HTTPException(422, "a breadth run takes no findingIds or direction")
        else:
            ids = list(dict.fromkeys(body.findingIds))
            unknown = [i for i in ids if not FINDING_ID.match(i) or i not in t.findings]
            if unknown:
                raise HTTPException(422, f"not in the ledger: {', '.join(unknown)}")
            target = runs.compose_target(ids, body.direction)
            if not target:
                raise HTTPException(422, "a focus run needs a finding id or a direction")
            if FINDING_ID.match(target) and target not in t.findings:  # a direction that is just an id
                raise HTTPException(422, f"not in the ledger: {target}")
            if not FINDING_ID.match(target) and (errs := runs.claim_errors(target)):
                raise HTTPException(422, f"focus target cannot be a finding claim: {'; '.join(errs)}")
        with launcher.mutex:
            if launcher.busy(slug):
                raise HTTPException(409, f"topic {slug} is already running")
            spawned = launcher.spawn(slug, t.title, body.windows, body.concurrency, target=target)
        return {"mode": body.mode, "target": target, "pid": settle_or_500(*spawned)}

    @app.post("/api/topics", status_code=202, dependencies=[Depends(local_json)])
    def topic_create(body: TopicRequest):
        title = body.title.strip()
        slug = runs.slugify(title)
        if not slug:
            raise HTTPException(422, "title has no letters or digits to make a slug from")
        brief = body.brief.strip()
        if len(brief) > runs.BRIEF_CAP:
            raise HTTPException(422, f"brief is {len(brief)} chars; limit is {runs.BRIEF_CAP}")
        with launcher.mutex:
            if (store.root / slug).exists() or launcher.busy(slug):
                raise HTTPException(409, {"error": f"topic {slug} exists", "slug": slug})
            spawned = launcher.spawn(slug, title, body.windows, body.concurrency, brief=brief or None)
        return {"slug": slug, "pid": settle_or_500(*spawned)}

    @app.post("/api/topics/{slug}/stop", status_code=202, dependencies=[Depends(local_json)])
    def run_stop(slug: str):
        topic(slug)
        pid = launcher.stop(slug)
        if pid is None:
            raise HTTPException(404, f"topic {slug} is not running")
        return {"pid": pid}

    @app.post("/api/render", dependencies=[Depends(local_json)])
    def render_md(body: RenderRequest):
        """Preview for Markdown typed into the new-topic form (no topic, so ids are not linked)."""
        return rendered(body.md)

    @app.get("/api/events")
    def event_stream():
        return StreamingResponse(events.stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    # Mounted last so /api routes take precedence; html=True serves index.html at /.
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
    return app
