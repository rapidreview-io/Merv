"""Small reusable checks over verified support-system facts."""

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


def review_requested(snapshot: Snapshot, knowledge: Knowledge):
    if not knowledge.read(Reference("review_snapshot", snapshot.id)):
        return Issue("review_not_requested", "Create an independent review of the submitted evidence.", "request_review", ("review.request",))


def review_summary(fact) -> str:
    """Carry the durable review reason into a later agent's assignment."""
    findings = "; ".join(str(item.get("issue") or "") for item in fact.get("findings") or () if item.get("issue"))
    return "\n".join(str(part) for part in (
        f"{fact.get('role', 'Reviewer')} returned {fact.get('verdict', '')}",
        fact.get("notes") or fact.get("synopsis"),
        f"Findings: {findings}" if findings else "",
    ) if part)
