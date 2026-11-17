import json

import httpx
import pytest
from test_models import FINDING, PAPER, VERIFICATION

from arui.__main__ import SCHEMA_DIR, backfill_papers, export_schema, inline_refs, main, s2_api_key, validate


def test_inline_refs_keeps_siblings():
    schema = {"$defs": {"E": {"type": "object"}}, "properties": {"e": {"$ref": "#/$defs/E", "description": "d"}}}
    assert inline_refs(schema) == {"properties": {"e": {"type": "object", "description": "d"}}}


def test_committed_schema_up_to_date():
    assert export_schema(check=True) == 0


def test_check_detects_drift(tmp_path):
    assert export_schema(check=True, out=tmp_path) == 1
    assert export_schema(check=False, out=tmp_path) == 0
    assert export_schema(check=True, out=tmp_path) == 0
    (tmp_path / "finding.schema.json").write_text("{}\n")
    assert export_schema(check=True, out=tmp_path) == 1


def test_schemas_are_flat_objects():
    for path in SCHEMA_DIR.glob("*.schema.json"):
        schema = json.loads(path.read_text())
        assert schema["type"] == "object"
        assert "$defs" not in schema and "$ref" not in path.read_text()


def test_validate_reports_bad_lines(tmp_path, capsys):
    topic = tmp_path / "t"
    topic.mkdir()
    (topic / "ledger.jsonl").write_text(json.dumps(FINDING) + "\n" + json.dumps({**FINDING, "title": "x"}) + "\n{truncated\n\n")
    (topic / "verifications.jsonl").write_text(json.dumps(VERIFICATION) + "\n")
    assert validate("t", topics=tmp_path) == 1
    out = capsys.readouterr().out.splitlines()
    assert len(out) == 2
    assert out[0].startswith("ledger.jsonl:2: title:")
    assert out[1].startswith("ledger.jsonl:3:")


def test_validate_clean_topic(tmp_path):
    topic = tmp_path / "t"
    topic.mkdir()
    (topic / "ledger.jsonl").write_text(json.dumps(FINDING) + "\n")
    (topic / "verifications.jsonl").write_text(json.dumps(VERIFICATION) + "\n")
    assert validate("t", topics=tmp_path) == 0


def test_validate_unknown_topic(tmp_path):
    assert validate("nope", topics=tmp_path) == 2


def test_main_check():
    assert main(["export-schema", "--check"]) == 0


MERGED = "e" * 40


def s2_client(calls, statuses=()):
    """Fake S2 batch endpoint: answers each id with a paper, except ids starting with "0" (unknown)."""
    statuses = list(statuses)

    def handler(req):
        if statuses:
            return httpx.Response(statuses.pop(0))
        ids = json.loads(req.content)["ids"]
        calls.append(ids)
        if all(i[0] == "0" for i in ids):
            return httpx.Response(400, json={"error": "No valid paper ids given"})
        authors = [{"name": n} for n in "ABCD"]
        # S2 answers with its canonical paperId, which differs for merged papers.
        return httpx.Response(
            200,
            json=[
                None if i[0] == "0" else {"paperId": "c" * 40 if i == MERGED else i, "title": f"T {i[:4]}", "year": 2024, "venue": "", "authors": authors}
                for i in ids
            ],
        )

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_backfill_papers(tmp_path, capsys):
    topic = tmp_path / "t"
    topic.mkdir()
    ids = [f"{i:040x}".replace("0", "b", 1) for i in range(1, 599)] + [MERGED]  # 599 fetchable ids
    unknown = "0" * 39 + "1"
    (topic / "ledger.jsonl").write_text(json.dumps({**FINDING, "sources": [PAPER, *ids[:30], "f-0123abcd", "arXiv:2401.00001"]}) + "\n")
    cited = [*ids, unknown]
    (topic / "verifications.jsonl").write_text("".join(json.dumps({**VERIFICATION, "sources": cited[i : i + 40]}) + "\n" for i in range(0, len(cited), 40)))
    (topic / "papers.jsonl").write_text(json.dumps({"paperId": PAPER, "title": "Cached"}) + "\n")
    calls, sleeps = [], []
    assert backfill_papers("t", topics=tmp_path, client=s2_client(calls, [429]), sleep=sleeps.append) == 0
    assert [len(c) for c in calls] == [500, 100]
    assert PAPER not in calls[0] and "arXiv:2401.00001" not in calls[0]
    assert sleeps == [2, 1.1]  # one 429 backoff, one gap between batches
    lines = [json.loads(line) for line in (topic / "papers.jsonl").read_text().splitlines()]
    assert len(lines) == 1 + 599
    assert lines[1] == {"paperId": ids[0], "title": f"T {ids[0][:4]}", "year": 2024, "venue": "", "authors": ["A", "B", "C"]}
    assert lines[-1]["paperId"] == MERGED
    assert "601 cited, 1 already cached, 599 added, 1 not found" in capsys.readouterr().out

    # A rerun only asks for the id S2 did not know.
    calls.clear()
    assert backfill_papers("t", topics=tmp_path, client=s2_client(calls), sleep=sleeps.append) == 0
    assert calls == [[unknown]]
    assert "0 added, 1 not found" in capsys.readouterr().out


def test_backfill_papers_gives_up_after_retries(tmp_path):
    topic = tmp_path / "t"
    topic.mkdir()
    (topic / "ledger.jsonl").write_text(json.dumps(FINDING) + "\n")
    sleeps = []
    with pytest.raises(RuntimeError, match="Semantic Scholar 503"):
        backfill_papers("t", topics=tmp_path, client=s2_client([], [503] * 6), sleep=sleeps.append)
    assert sleeps == [2, 4, 8, 16, 32]
    assert not (topic / "papers.jsonl").exists()


def test_backfill_papers_unknown_topic(tmp_path):
    assert backfill_papers("nope", topics=tmp_path) == 2


def test_s2_api_key_from_env_file(tmp_path, monkeypatch):
    monkeypatch.delenv("S2_API_KEY", raising=False)
    env = tmp_path / ".env"
    assert s2_api_key(env) is None
    env.write_text('# comment\nOTHER=1\nS2_API_KEY="abc"\n')
    assert s2_api_key(env) == "abc"
    monkeypatch.setenv("S2_API_KEY", "fromenv")
    assert s2_api_key(env) == "fromenv"
