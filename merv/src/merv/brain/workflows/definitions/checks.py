"""Small helpers every research graph shares: review checks and brief text.

A passing review and an open review request are declared as a node
``ReviewGate`` requirement; the checks here read a verdict that already landed.
"""

from ..graph import Issue, Knowledge, Reference, Snapshot


def reviewed(role: str, *, verdict: str = "pass", return_to: str = ""):
    def check(snapshot: Snapshot, knowledge: Knowledge):
        fact = knowledge.read(Reference("review", role))
        valid = fact.get("passed") if verdict == "pass" else fact.get("verdict") == verdict
        if return_to:
            valid = valid and fact.get("return_to") == return_to
        if not valid:
            reason = (fact.get("error") if verdict == "pass" else "") or f"A {role} verdict of {verdict!r} is required."
            return Issue(f"{role}_required", str(reason),
                         "request_review", ("review.request",))

    return check


def rejected(role: str, return_to: str):
    """A needs_changes or fail verdict from ``role`` that routed the target to ``return_to``."""
    def check(snapshot: Snapshot, knowledge: Knowledge):
        fact = knowledge.read(Reference("review", role))
        if fact.get("verdict") not in {"needs_changes", "fail"} or fact.get("return_to") != return_to:
            return Issue(f"{role}_required", f"An independent rejected review from {role} returning to {return_to!r} is required.",
                         "request_review", ("review.request",))

    return check


def review_summary(fact) -> str:
    """Carry the durable review reason into a later agent's assignment."""
    findings = "; ".join(str(item.get("issue") or "") for item in fact.get("findings") or () if item.get("issue"))
    return "\n".join(str(part) for part in (
        f"{fact.get('role', 'Reviewer')} returned {fact.get('verdict', '')}",
        fact.get("notes") or fact.get("synopsis"),
        f"Findings: {findings}" if findings else "",
    ) if part)


def short(value, words: int) -> str:
    """The first ``words`` words of a value, marked when it was cut."""
    parts = str(value or "").split()
    return " ".join(parts[:words]) + ("…" if len(parts) > words else "")


def evidence_references(artifacts):
    """One artifact Reference per association row, labelled by its role."""
    return tuple(Reference("artifact", str(item.get("artifact_id") or item.get("id")),
                           str(item.get("role") or item.get("label") or "Evidence"))
                 for item in artifacts if item.get("artifact_id") or item.get("id"))
