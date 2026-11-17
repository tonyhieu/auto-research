"""Effective status, novelty, and buckets: a port of applyVerifications in src/ledger.ts (kept in sync by test/fixtures/derivation.json)."""

from typing import Literal, NamedTuple

from arui.models import Finding, Verification

Check = Literal["citation", "adversarial", "novelty", "reproduce"]
Bucket = Literal["main", "refuted", "known", "pending"]


class Effective(NamedTuple):
    status: Literal["unverified", "verified", "refuted"]
    novelty: Literal["novel", "known"] | None


def reproducible(f: Finding) -> bool:
    """Only insights can rest on a computation, so only they get a reproduce check."""
    return f.kind not in ("gap", "literature")


def latest_verdicts(vs: list[Verification]) -> dict[str, dict[str, Verification]]:
    """findingId -> check -> latest verification by ts (ties: later in file wins, as in the stable TS sort)."""
    latest: dict[str, dict[str, Verification]] = {}
    for v in sorted(vs, key=lambda v: v.ts):
        latest.setdefault(v.findingId, {})[v.check] = v
    return latest


def effective(f: Finding, latest: dict[str, Verification] | None) -> Effective:
    """A failed citation, adversarial, or reproduce check refutes; citation and adversarial passing (and reproduce, if recorded) verifies."""
    if not latest:
        return Effective(f.status, None)
    m = {c: v.verdict for c, v in latest.items()}
    rep = m.get("reproduce") if reproducible(f) else None
    if m.get("citation") == "fail" or m.get("adversarial") == "fail" or rep == "fail":
        status = "refuted"
    elif m.get("citation") == "pass" and m.get("adversarial") == "pass" and rep in (None, "pass"):
        status = "verified"
    else:
        status = f.status
    n = m.get("novelty")
    return Effective(status, "novel" if n == "pass" else "known" if n == "fail" else None)


def apply_verifications(findings: list[Finding], vs: list[Verification]) -> dict[str, Effective]:
    latest = latest_verdicts(vs)
    return {f.id: effective(f, latest.get(f.id)) for f in findings}


def bucket(e: Effective) -> Bucket:
    if e.status == "refuted":
        return "refuted"
    return "main" if e.novelty == "novel" else "known" if e.novelty == "known" else "pending"


def checks(f: Finding, latest: dict[str, Verification] | None) -> dict[str, str | None]:
    """Latest verdict per check chip; reproduce only for reproducible findings."""
    names: list[Check] = ["citation", "adversarial", "reproduce", "novelty"] if reproducible(f) else ["citation", "adversarial", "novelty"]
    return {c: latest[c].verdict if latest and c in latest else None for c in names}


def superseded(v: Verification, latest: dict[str, dict[str, Verification]]) -> bool:
    return latest.get(v.findingId, {}).get(v.check) is not v


def latest_focus(vs: list[Verification]) -> Verification | None:
    """The most recent verification carrying a focus outcome."""
    focused = sorted((v for v in vs if v.focus), key=lambda v: v.ts)
    return focused[-1] if focused else None


def orchestrator_heading(text: str) -> str | None:
    """First `##` heading line of state/orchestrator.md, the fallback main hypothesis."""
    for line in text.splitlines():
        if line.startswith("## "):
            return line[3:].strip()
    return None
