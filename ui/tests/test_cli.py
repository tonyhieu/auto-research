import json

from test_models import FINDING, VERIFICATION

from arui.__main__ import SCHEMA_DIR, export_schema, inline_refs, main, validate


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
