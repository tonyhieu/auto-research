import argparse
import json
import sys
from pathlib import Path

from pydantic import BaseModel, ValidationError

from arui.models import Finding, FindingInput, VerdictInput, Verification

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
    srv = sub.add_parser("serve", help="serve the UI API on 127.0.0.1")
    srv.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    if args.cmd == "export-schema":
        return export_schema(args.check)
    if args.cmd == "serve":
        return serve(args.port)
    return validate(args.slug)


if __name__ == "__main__":
    sys.exit(main())
