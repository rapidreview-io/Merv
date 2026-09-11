# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Compatibility presentation of canonical workflow evaluations and project hints."""

from __future__ import annotations

from ..research_core import EXPERIMENT, TASK, GateEvaluation, project_fields, project_rows
from .reflection_guidance import idle_reflection_hint, present_reflection_signal, reflection_create_block_reason


_SLIM_REFLECTION_FIELDS = ("id", "title", "status", "attempt_index", "revision_context",
                           "reflection_coverage")


class StatusGuidancePolicy:
    """Format decisions already evaluated by Workflows; never evaluate another gate."""

    def __init__(self, *, storage_enabled=False, storage_guidance=None):
        self.storage_guidance = dict(storage_guidance or {"enabled": bool(storage_enabled)})

    def project_setup(self):
        return self._next(gate="project_setup", action="create_claim_or_experiment",
                          allowed=["claim.create", "experiment.create", "task.create"])

    def experiment(self, *, experiment, sandboxes, evaluation: GateEvaluation):
        return self._workflow(revision_context=experiment.revision_context, evaluation=evaluation)

    def task(self, *, task, evaluation: GateEvaluation):
        return self._workflow(revision_context=task.get("revision_context") or "", evaluation=evaluation)

    def _reflection_workflow_for(self, *, reflection, evaluation: GateEvaluation):
        return self._workflow(revision_context=reflection.get("revision_context") or "", evaluation=evaluation)

    def _workflow(self, *, revision_context, evaluation: GateEvaluation):
        decision = evaluation.decision
        if decision is None:
            raise RuntimeError("canonical workflow evaluation is missing")
        selected = decision.suggested
        issues = tuple(dict.fromkeys((*decision.dispatch_issues, *(() if selected is None else selected.issues))))
        first = next(iter(issues), None)
        tools = tuple(tool for issue in issues for tool in issue.tools)
        if not tools and selected is not None and selected.available:
            tools = selected.edge.tools or ("workflow.transition",)
        result = {
            **decision.public(),
            "current_gate": first.code if first is not None else "terminal" if decision.snapshot.outcome else decision.snapshot.state,
            "next_action": (first.action or "resolve_workflow_blocker") if first is not None else "none" if selected is None else selected.edge.name,
            "allowed_actions": list(dict.fromkeys(tools)),
            "missing_evidence": [issue.message for issue in issues],
            "revision_context": revision_context,
        }
        # This is request metadata for older views, not another review policy.
        review = evaluation.review
        if review is not None and decision.node is not None and decision.node.execution.read_only:
            item = next(iter(review.items), {})
            status = "attested_blocked" if review.problems and review.status == "pending" else review.status
            result["review_gate"] = {
                "role": decision.node.role, "target_type": decision.snapshot.workflow,
                "target_id": decision.snapshot.id, "status": status,
                "read_only": True,
                **{name: item[name] for name in ("request_id", "expires_at", "skill", "label") if item.get(name)},
            }
        return result

    def project_reflection(self, *, open_wave, evaluation, signal, idle):
        presented = present_reflection_signal(signal) or {}
        if open_wave is not None:
            if evaluation is None:
                raise RuntimeError("reflection gate evaluation is missing")
            workflow = self._reflection_workflow_for(reflection=open_wave, evaluation=evaluation)
            if signal.get("experiment_create_blocked"):
                workflow = self._with_experiment_create_block(workflow=workflow, signal=signal)
            return {"reflection": self._slim_reflection(open_wave), "workflow": workflow, "signal": presented}
        recommended = idle and signal.get("has_new_material")
        if not signal.get("stale") and not recommended:
            return None
        return {
            "reflection": None, "hint": presented.get("hint") or idle_reflection_hint(signal=signal),
            "signal": presented, "experiment_create_blocked": bool(signal.get("experiment_create_blocked")),
            **({"recommended": True} if recommended else {}),
        }

    def reflection_workflow_takeover(self, *, reflection):
        if reflection is None:
            return None
        if reflection.get("reflection") is not None:
            return reflection["workflow"]
        signal = reflection.get("signal") or {}
        if signal.get("experiment_create_blocked"):
            reason = reflection.get("hint") or reflection_create_block_reason(signal=signal)
            return self._next(gate="reflection_required", action="start_project_reflection_before_next_experiment",
                              allowed=["reflection.create", "claim.create", "task.create"],
                              blocked=[{"action": "experiment.create", "reason": reason}], missing=[reason] if reason else [])
        if reflection.get("recommended"):
            return self._next(gate="reflection_suggested", action="consider_project_reflection",
                              allowed=["reflection.create", "claim.create", "experiment.create", "task.create"],
                              missing=[reflection["hint"]] if reflection.get("hint") else [])
        return None

    def live_experiments_takeover(self, *, exp_rows, reflection, task_rows=None):
        live = project_rows([row for row in exp_rows if row.status not in EXPERIMENT.workflow.outcomes],
                            ("id", "name", "status", "attempt_index", "intent"))
        tasks = project_rows([row for row in task_rows or [] if row["status"] not in TASK.workflow.outcomes],
                             ("id", "name", "status", "goal"))
        signal = (reflection or {}).get("signal") or {}
        allowed, blocked = ["workflow.status_and_next", "task.create"], []
        if signal.get("experiment_create_blocked"):
            reason = (reflection or {}).get("hint") or reflection_create_block_reason(signal=signal)
            blocked.append({"action": "experiment.create", "reason": reason})
        else:
            allowed.append("experiment.create")
        return self._next(gate="live_experiments", action="tend_live_work", allowed=allowed,
                          blocked=blocked, live_experiments=live, live_tasks=tasks)

    def _with_experiment_create_block(self, *, workflow, signal):
        reason = reflection_create_block_reason(signal=signal)
        return {
            **workflow,
            "allowed_actions": [action for action in workflow.get("allowed_actions", []) if action != "experiment.create"],
            "blocked_actions": [item for item in workflow.get("blocked_actions", []) if item.get("action") != "experiment.create"]
                               + [{"action": "experiment.create", "reason": reason}],
        }

    def _slim_reflection(self, reflection):
        return {
            **project_fields(reflection, _SLIM_REFLECTION_FIELDS),
            "roster": project_rows(reflection.get("roster", []), ("id", "title", "core")),
            "current_attempt_artifacts": project_rows(reflection.get("current_attempt_artifacts", []),
                                                      ("id", "role", "lens_id", "path", "size_bytes", "tldr")),
            "reviews": project_rows(reflection.get("reviews", []), ("id", "role", "verdict", "created_at", "synopsis")),
            "allowed_transitions": reflection.get("allowed_transitions", []),
        }

    @staticmethod
    def _next(*, gate, action, allowed, blocked=None, missing=None, **details):
        return {"current_gate": gate, "next_action": action, "allowed_actions": allowed,
                "blocked_actions": blocked or [], "missing_evidence": missing or [], "revision_context": "", **details}


__all__ = ["StatusGuidancePolicy"]
