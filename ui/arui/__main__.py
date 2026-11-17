import argparse
import json
import os
import re
import sys
import time
from collections.abc import Callable
from pathlib import Path

import httpx
from pydantic import BaseModel, ValidationError

from arui.models import Finding, FindingInput, Paper, VerdictInput, Verification
from arui.store import read_jsonl

REPO = Path(__file__).resolve().parents[2]
SCHEMA_DIR = REPO / "schema"
TOPICS = REPO / "topics"

SCHEMAS: dict[str, type[BaseModel]] = {
    "finding-input": FindingInput,
    "finding": Finding,
    "verdict-input": VerdictInput,
    "verification": Verification,
}


def inline_refs(schema: dict) -> dict:
    """Replace every $ref with its $defs entry, since tool input schemas must be flat objects."""
    defs = schema.pop("$defs", {})

    def walk(node):
        if isinstance(node, dict):
            if "$ref" in node:
                # Keep sibling keys (e.g. description) alongside the inlined definition.
                siblings = {k: walk(v) for k, v in node.items() if k != "$ref"}
                return {**walk(defs[node["$ref"].removeprefix("#/$defs/")]), **siblings}
            return {k: walk(v) for k, v in node.items()}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(schema)


def render_schemas() -> dict[str, str]:
    return {f"{name}.schema.json": json.dumps(inline_refs(model.model_json_schema()), indent=2) + "\n" for name, model in SCHEMAS.items()}


def export_schema(check: bool, out: Path = SCHEMA_DIR) -> int:
    files = render_schemas()
    if check:
        stale = [n for n, text in files.items() if not (out / n).exists() or (out / n).read_text() != text]
        for n in stale:
            print(f"{out / n} is out of date; run `uv run arui export-schema`", file=sys.stderr)
        return 1 if stale else 0
    out.mkdir(exist_ok=True)
    for n, text in files.items():
        (out / n).write_text(text)
    return 0


def validate_file(path: Path, model: type[BaseModel]) -> list[str]:
    """One message per invalid line; blank lines are skipped."""
    if not path.exists():
        return [f"{path}: missing"]
    failures = []
    for i, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            model.model_validate_json(line)
        except ValidationError as e:
            errs = "; ".join(f"{'.'.join(map(str, err['loc'])) or '<line>'}: {err['msg']}" for err in e.errors())
            failures.append(f"{path.name}:{i}: {errs}")
    return failures


def validate(slug: str, topics: Path = TOPICS) -> int:
    topic = topics / slug
    if not topic.is_dir():
        print(f"no topic {slug} in {topics}", file=sys.stderr)
        return 2
    failures = validate_file(topic / "ledger.jsonl", Finding) + validate_file(topic / "verifications.jsonl", Verification)
    for f in failures:
        print(f)
    print(f"{len(failures)} invalid line(s)", file=sys.stderr)
    return 1 if failures else 0


S2_BATCH = "https://api.semanticscholar.org/graph/v1/paper/batch"
BATCH_SIZE = 500  # S2's per-call id limit
MIN_GAP_S = 1.1  # as in s2.ts: S2 429s at ~1 req/s
MAX_RETRIES = 5
PAPER_ID = re.compile(r"^[0-9a-f]{40}$")  # only bare paperIds: the server looks papers up by these


def s2_api_key(env_file: Path = REPO / ".env") -> str | None:
    """S2_API_KEY from the environment, else from the repo .env that cli.ts loads."""
    if key := os.environ.get("S2_API_KEY"):
        return key
    lines = env_file.read_text().splitlines() if env_file.exists() else []
    return next((v.strip().strip("\"'") for k, _, v in (line.partition("=") for line in lines) if k.strip() == "S2_API_KEY"), None)


def fetch_batch(client: httpx.Client, ids: list[str], key: str | None, sleep: Callable[[float], None]) -> list[dict | None]:
    """One S2 batch call, retrying 429/5xx with backoff like s2.ts. Results align with ids; unknown ids are None."""
    for attempt in range(MAX_RETRIES + 1):
        res = client.post(S2_BATCH, params={"fields": "paperId,title,year,venue,authors"}, json={"ids": ids}, headers={"x-api-key": key} if key else {})
        if res.is_success:
            return res.json()
        if res.status_code == 400 and "No valid paper ids" in res.text:  # S2's answer when every id is unknown
            return [None] * len(ids)
        if (res.status_code == 429 or res.status_code >= 500) and attempt < MAX_RETRIES:
            sleep(2 * 2**attempt)
            continue
        raise RuntimeError(f"Semantic Scholar {res.status_code}: {res.text[:200]}")
    raise AssertionError("unreachable")


def backfill_papers(slug: str, topics: Path = TOPICS, client: httpx.Client | None = None, sleep: Callable[[float], None] = time.sleep) -> int:
    """Append papers.jsonl lines for cited paperIds that the harness cache does not have yet."""
    topic = topics / slug
    if not topic.is_dir():
        print(f"no topic {slug} in {topics}", file=sys.stderr)
        return 2
    findings, bad_f = read_jsonl(topic / "ledger.jsonl", Finding)
    verifications, bad_v = read_jsonl(topic / "verifications.jsonl", Verification)
    if bad_f or bad_v:
        print(f"skipped {bad_f + bad_v} invalid line(s); run `arui validate {slug}`", file=sys.stderr)
    cached = {p.paperId for p in read_jsonl(topic / "papers.jsonl", Paper)[0]}
    cited = dict.fromkeys(s for r in [*findings, *verifications] for s in r.sources if PAPER_ID.match(s))
    missing = [pid for pid in cited if pid not in cached]
    client = client or httpx.Client(timeout=60)
    key = s2_api_key()
    found = 0
    for i in range(0, len(missing), BATCH_SIZE):
        if i:
            sleep(MIN_GAP_S)
        batch = missing[i : i + BATCH_SIZE]
        # Keyed by the cited id, not S2's paperId (which differs for merged papers), since lookups go by source id.
        lines = [
            Paper(
                paperId=pid,
                title=p.get("title"),
                year=p.get("year"),
                venue=p.get("venue"),
                authors=[a["name"] for a in (p.get("authors") or []) if a.get("name")][:3],
            )
            for pid, p in zip(batch, fetch_batch(client, batch, key, sleep), strict=True)
            if p
        ]
        # Unbuffered, one write per line, so lines cannot interleave with a running harness's cache appends.
        with (topic / "papers.jsonl").open("ab", buffering=0) as f:
            for line in lines:
                f.write((line.model_dump_json(exclude_none=True) + "\n").encode())
        found += len(lines)
    print(f"{len(cited)} cited, {len(cited) - len(missing)} already cached, {found} added, {len(missing) - found} not found")
    return 0


def serve(port: int) -> int:
    import uvicorn

    from arui.server import create_app
    from arui.store import Store

    app = create_app(Store(TOPICS))

    class Server(uvicorn.Server):
        def handle_exit(self, sig, frame):
            app.state.events.close()  # SSE streams never finish on their own; shutdown waits on them
            super().handle_exit(sig, frame)

    # Localhost only: there is no auth.
    Server(uvicorn.Config(app, host="127.0.0.1", port=port, timeout_graceful_shutdown=5)).run()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="arui")
    sub = parser.add_subparsers(dest="cmd", required=True)
    exp = sub.add_parser("export-schema", help="write schema/*.schema.json from the Pydantic models")
    exp.add_argument("--check", action="store_true", help="exit non-zero if the committed files differ")
    val = sub.add_parser("validate", help="validate a topic's ledger and verifications")
    val.add_argument("slug")
    bf = sub.add_parser("backfill-papers", help="fetch metadata for cited papers missing from papers.jsonl")
    bf.add_argument("slug")
    srv = sub.add_parser("serve", help="serve the UI API on 127.0.0.1")
    srv.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    if args.cmd == "export-schema":
        return export_schema(args.check)
    if args.cmd == "serve":
        return serve(args.port)
    if args.cmd == "backfill-papers":
        return backfill_papers(args.slug)
    return validate(args.slug)


if __name__ == "__main__":
    sys.exit(main())
