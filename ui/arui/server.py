"""Read-only JSON API over topics/<slug>/ ledgers, plus the static app in ui/static/."""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from arui import runs
from arui.derive import checks, latest_focus, orchestrator_heading, superseded
from arui.render import rendered
from arui.store import Store, Topic, list_docs, read_doc

STATIC = Path(__file__).resolve().parents[1] / "static"


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


def create_app(store: Store) -> FastAPI:
    app = FastAPI(title="arui")

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

    # Mounted last so /api routes take precedence; html=True serves index.html at /.
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
    return app
