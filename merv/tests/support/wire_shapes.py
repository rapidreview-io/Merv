"""One seeded project, and every public shape the UI and the agents read.

`capture()` drives a local brain through a project that exercises each record
kind in each interesting state, then records what every route and tool returns.
Volatile values (ids, timestamps, hashes) are normalized so two runs compare.
`python -m tests.support.wire_shapes` rewrites `tests/fixtures/wire_shapes.json`.
"""

from __future__ import annotations

import itertools
import json
import re
import tempfile
import threading
import uuid
from datetime import UTC as datetime_utc, timedelta
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from merv.brain.kernel import utils as kernel_utils
from merv.brain.surface.transport.api import create_fastapi_app
from tests.research_core.scenarios import (
    LENSES,
    REVIEW_SYNOPSIS,
    VALID_CHANGE_SPEC,
    VALID_GRAPH,
    VALID_PLAN,
    VALID_PROJECT_GRAPH,
    VALID_REFLECTION,
    VALID_REPORT,
    complete_no_code_consolidation,
)
from tests.support.brain import TestBrain

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "wire_shapes.json"

_ID_RE = re.compile(r"\b([a-z][a-z0-9_]*)_[0-9a-f]{12}\b")
_TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")
_SHA_RE = re.compile(r"^[0-9a-f]{40,64}$")


class _Tick:
    """``datetime`` whose clock advances a second per read, from real now.

    Recency sorts read stored timestamps, and second precision puts a whole
    scenario inside one or two seconds, so real time orders rows differently
    on every run. Ticking keeps the order the work happened in.
    """

    def __init__(self, real: Any) -> None:
        self._real = real
        self._at = real.now(datetime_utc).replace(microsecond=0)
        self._lock = threading.Lock()

    def now(self, tz: Any = None) -> Any:
        with self._lock:
            self._at += timedelta(seconds=1)
            return self._at

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


class _Counter:
    """Monotonic stand-in for ``uuid4`` so ids order rows the way work happened.

    Rows created in the same second tie-break on id, so random ids reorder a
    list between runs. A counter in the high bits keeps ids sorted by age and
    the capture reproducible; the values themselves are normalized away.
    """

    def __init__(self) -> None:
        self._next = itertools.count(1)
        self._lock = threading.Lock()

    def __call__(self) -> uuid.UUID:
        with self._lock:
            return uuid.UUID(int=next(self._next) << 80)


DELIVERY = """\
# Delivery

## Confirmations
1. done — the note is written. evidence: notes.md. how: open notes.md.

## Notes
The task produced the note it promised.
"""


def normalize(value: Any) -> Any:
    """Replace what changes between runs, keeping structure and key order."""
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if isinstance(value, str):
        if _TIME_RE.match(value):
            return "<time>"
        if _SHA_RE.match(value):
            return "<sha>"
        return _ID_RE.sub(lambda match: f"<{match.group(1)}>", value)
    return value


class Scenario:
    """A project driven far enough that every presenter has something to show."""

    def __init__(self, root: Path) -> None:
        self.app = TestBrain(repo_root=root, db_path=root / ".research_plugin" / "state.sqlite")
        self.client = TestClient(create_fastapi_app(self.app))
        self.project_id = self.call("project", action="create", name="Wire Shapes")["id"]
        # The bootstrap project is not part of the scenario; hiding it keeps
        # every project listing to the one project this capture drives.
        for project in self.app.research.list_projects()["projects"]:
            if project["id"] != self.project_id:
                self.app.research.update_project(project_id=project["id"], hidden=True)

    def close(self) -> None:
        self.client.close()
        self.app.shutdown()

    # ---- driving ----

    def call(self, tool: str, **arguments: Any) -> dict[str, Any]:
        return self.app.call_tool(tool, arguments)

    def submit(self, *, target_type: str, target_id: str, role: str, body: str,
               path: str, lens_id: str = "") -> str:
        result = self.app.submit_artifact(
            project_id=self.project_id, target_type=target_type, target_id=target_id,
            role=role, path=path, body=body, lens_id=lens_id,
        )
        return str(result["artifact_id"])

    def review(self, *, target_type: str, target_id: str, role: str, verdict: str = "pass",
               return_to: str = "") -> dict[str, Any]:
        request = self.call("review.request", project_id=self.project_id, target_type=target_type,
                            target_id=target_id, role=role, producer_session_id="producer")
        session = self.call("review.start", review_request_id=request["review_request_id"],
                            reviewer_capability=request["reviewer_capability"],
                            caller_session_id="independent-reviewer")
        arguments = {"review_session_id": session["review_session_id"], "verdict": verdict,
                     "synopsis": REVIEW_SYNOPSIS}
        if return_to:
            arguments["return_to"] = return_to
        return self.call("review.submit", **arguments)

    def experiment(self, name: str, *, claim_ids: list[str] | None = None) -> str:
        return str(self.call("experiment.create", project_id=self.project_id, name=name,
                             intent=f"Test what {name} is for.",
                             details="The immutable detail the ask pinned.",
                             tested_claim_ids=claim_ids or [])["id"])

    def transition(self, experiment_id: str, transition: str) -> dict[str, Any]:
        return self.call("experiment.transition", project_id=self.project_id,
                         experiment_id=experiment_id, transition=transition)

    def running_experiment(self, name: str, *, claim_ids: list[str] | None = None) -> str:
        experiment_id = self.experiment(name, claim_ids=claim_ids)
        self.submit(target_type="experiment", target_id=experiment_id, role="plan",
                    path="plan.md", body=VALID_PLAN)
        self.transition(experiment_id, "submit_design")
        self.review(target_type="experiment", target_id=experiment_id, role="design_reviewer")
        return experiment_id

    def reviewed_experiment(self, name: str, *, claim_ids: list[str] | None = None) -> str:
        experiment_id = self.running_experiment(name, claim_ids=claim_ids)
        for role, path, body in (("result", "results.json", '{"accuracy": 0.72}'),
                                 ("report", "report.md", VALID_REPORT),
                                 ("graph", "graph.json", VALID_GRAPH)):
            self.submit(target_type="experiment", target_id=experiment_id, role=role,
                        path=path, body=body)
        self.transition(experiment_id, "submit_results")
        return experiment_id

    def seed(self) -> dict[str, Any]:
        claim = self.call("claim.create", project_id=self.project_id,
                          statement="The schedule improves accuracy.", scope="This project.")["id"]
        self.call("claim.create", project_id=self.project_id,
                  statement="Transfer is untested.", confidence="low")
        planned = self.experiment("planned-work", claim_ids=[claim])
        running = self.running_experiment("running-work", claim_ids=[claim])
        in_review = self.reviewed_experiment("review-work", claim_ids=[claim])
        complete = self.reviewed_experiment("complete-work", claim_ids=[claim])
        self.review(target_type="experiment", target_id=complete, role="experiment_reviewer")
        rejected = self.reviewed_experiment("rejected-work")
        self.review(target_type="experiment", target_id=rejected, role="experiment_reviewer",
                    verdict="needs_changes", return_to="planned")
        open_task = str(self.call("task.create", project_id=self.project_id, name="open-task",
                                  goal="Write the note the wave needs.",
                                  deliverables=["notes.md exists and states the finding"])["id"])
        done_task = str(self.call("task.create", project_id=self.project_id, name="done-task",
                                  goal="Record the finished note.",
                                  deliverables=["notes.md exists and states the finding"])["id"])
        self.submit(target_type="task", target_id=done_task, role="delivery",
                    path=f"tasks/done-task/delivery.md", body=DELIVERY)
        self.call("task.transition", project_id=self.project_id, task_id=done_task,
                  transition="submit_delivery")
        self.review(target_type="task", target_id=done_task, role="task_reviewer")
        # A wave over the covered terminal work, published through the code gate.
        reflection = str(self.call("reflection.create", project_id=self.project_id,
                                   title="Wave one",
                                   lenses=[dict(lens) for lens in LENSES])["id"])
        for lens in LENSES:
            lens_id = str(lens["id"])
            self.submit(target_type="reflection", target_id=reflection,
                        role="reflection_lens_doc", path=f"reflections/{lens_id}.md",
                        lens_id=lens_id,
                        body=f"# {lens_id}\n\n## Summary\nThe {lens_id} reading found a signal.")
        self.call("reflection.transition", project_id=self.project_id,
                  reflection_id=reflection, transition="submit_reflections")
        for role, path, body in (("project_graph", "project/logic_graph.json", VALID_PROJECT_GRAPH),
                                 ("reflection_doc", "project/reflection.md", VALID_REFLECTION),
                                 ("change_spec", "project/change_spec.json", VALID_CHANGE_SPEC)):
            self.submit(target_type="reflection", target_id=reflection, role=role,
                        path=path, body=body)
        self.call("reflection.transition", project_id=self.project_id,
                  reflection_id=reflection, transition="submit_reflection_artifacts")
        self.review(target_type="reflection", target_id=reflection, role="reflection_reviewer")
        complete_no_code_consolidation(app=self.app, project_id=self.project_id,
                                       reflection_id=reflection)
        # An open review request nobody answered: the recovery projection.
        self.call("review.request", project_id=self.project_id, target_type="experiment",
                  target_id=in_review, role="experiment_reviewer",
                  producer_session_id="producer")
        self.call("candidate.submit", project_id=self.project_id, name="champion-1",
                  source_kind="experiment_workspace", source_ref=complete,
                  metrics={"accuracy": 0.72}, primary_metric="accuracy",
                  validation_summary="The first promotable candidate.",
                  idempotency_key="wire-shapes-candidate-1")
        candidates = self.call("candidate.list", project_id=self.project_id)["candidates"]
        return {"claim_id": claim, "planned": planned, "running": running,
                "in_review": in_review, "complete": complete, "rejected": rejected,
                "open_task": open_task, "done_task": done_task, "reflection": reflection,
                "candidate": str(candidates[0]["id"]) if candidates else ""}

    # ---- capturing ----

    def get(self, path: str) -> Any:
        response = self.client.get(path)
        if response.status_code >= 400:
            raise AssertionError(f"GET {path} -> {response.status_code}: {response.text}")
        return response.json()

    def capture(self) -> dict[str, Any]:
        ids = self.seed()
        project, experiment = self.project_id, ids["in_review"]
        task, reflection = ids["open_task"], ids["reflection"]
        shapes: dict[str, Any] = {}
        for name, path in (
            ("http:project", f"/api/projects/{project}"),
            ("http:home", f"/api/projects/{project}/home"),
            ("http:claims", f"/api/projects/{project}/claims"),
            ("http:experiments", f"/api/projects/{project}/experiments"),
            ("http:experiment", f"/api/projects/{project}/experiments/{experiment}"),
            ("http:experiment_status", f"/api/projects/{project}/experiments/{experiment}/status"),
            ("http:tasks", f"/api/projects/{project}/tasks"),
            ("http:task", f"/api/projects/{project}/tasks/{task}"),
            ("http:reflections", f"/api/projects/{project}/reflections"),
            ("http:reflection", f"/api/projects/{project}/reflections/{reflection}"),
            ("http:reviews", f"/api/projects/{project}/reviews"),
            ("http:task_status", f"/api/projects/{project}/tasks/{task}/status"),
        ):
            shapes[name] = self.get(path)
        for name, tool, arguments in (
            ("tool:experiment.get_state", "experiment.get_state",
             {"project_id": project, "experiment_id": experiment}),
            ("tool:experiment.list", "experiment.list", {"project_id": project}),
            ("tool:task.get_state", "task.get_state", {"project_id": project, "task_id": task}),
            ("tool:task.list", "task.list", {"project_id": project}),
            ("tool:reflection.get", "reflection.get",
             {"project_id": project, "reflection_id": reflection}),
            ("tool:reflection.list", "reflection.list", {"project_id": project}),
            ("tool:review.status", "review.status",
             {"project_id": project, "target_type": "experiment", "target_id": experiment}),
            ("tool:candidate.list", "candidate.list", {"project_id": project}),
            ("tool:project.overview", "project", {"action": "overview", "project_id": project}),
            ("tool:project.current", "project", {"action": "current"}),
            ("tool:status.project", "workflow.status_and_next", {"project_id": project}),
            ("tool:status.experiment", "workflow.status_and_next",
             {"project_id": project, "experiment_id": experiment}),
            ("tool:status.task", "workflow.status_and_next",
             {"project_id": project, "task_id": task}),
            ("tool:consolidation.get", "consolidation.get",
             {"project_id": project, "reflection_id": reflection}),
        ):
            shapes[name] = self.call(tool, **arguments)
        return normalize(shapes)


def capture() -> dict[str, Any]:
    original = (kernel_utils.uuid4, kernel_utils.datetime)
    kernel_utils.uuid4, kernel_utils.datetime = _Counter(), _Tick(kernel_utils.datetime)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            scenario = Scenario(Path(tmp))
            try:
                return scenario.capture()
            finally:
                scenario.close()
    finally:
        kernel_utils.uuid4, kernel_utils.datetime = original


if __name__ == "__main__":  # pragma: no cover
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    shapes = capture()
    FIXTURE.write_text("{\n" + ",\n".join(f"  {json.dumps(k)}: {json.dumps(v)}" for k, v in shapes.items()) + "\n}\n")
    print(f"wrote {FIXTURE}")


__all__ = ["FIXTURE", "Scenario", "capture", "normalize"]
