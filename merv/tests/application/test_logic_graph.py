"""Application logic-graph read models."""

from __future__ import annotations

from tests.support.research_state import experiment_state

from dataclasses import replace
import unittest

from merv.brain.application.queries import LogicGraphQuery
from merv.brain.research_core import Artifact


class GraphResearch:
    """A Research root whose per-kind services answer for themselves."""

    def __init__(self) -> None:
        self.resolved = []
        self.experiments = _Bound(self, {"get_state": "experiment_state"})
        self.reflections = _Bound(self, {
            "get_state": "reflection_state",
            "project_logic_graph_selection": "project_logic_graph_selection",
        })

    def experiment_state(self, **_kwargs):
        return experiment_state(**{
            "id": "exp_1",
            "status": "running",
            "attempt_index": 2,
            "artifacts": [
                {
                    "id": "res_old",
                    "path": "old.json",
                    "role": "graph",
                    "attempt_index": 1,
                    "submitted_order": 1,
                    "association_version_id": "ver_old",
                },
                {
                    "id": "res_new",
                    "path": "new.json",
                    "role": "graph",
                    "attempt_index": 2,
                    "submitted_order": 2,
                    "association_version_id": "ver_new",
                },
            ],
        })

    def reflection_state(self, **_kwargs):
        return {"id": "syn_1", "attempt_index": 1, "artifacts": []}

    def project_logic_graph_selection(self, **_kwargs):
        return {"reflection": None, "graph_artifact": None, "signal": "stale"}

    def resolve_graph_refs(self, **kwargs):
        self.resolved.append(kwargs)
        return {
            ref: {"type": "claim", "resolved": True}
            for ref in kwargs["refs"]
            if ref == "claim_1"
        }


class _Bound:
    """Expose a fake's own methods under the names its service uses."""

    def __init__(self, research, names: dict[str, str]) -> None:
        self._research, self._names = research, names

    def __getattr__(self, name: str):
        return getattr(self._research, self._names[name])


class GraphArtifacts:
    def __init__(self) -> None:
        self.get_calls = []

    def _content(self, artifact_id: str) -> bytes | None:
        if artifact_id == "res_new":
            return (
                b'{"version":1,"nodes":['
                b'{"id":"n","label":"New","refs":["claim_1"]}]}'
            )
        return None

    def _reference(self, artifact_id: str) -> Artifact | None:
        return None

    def get(self, **kwargs):
        self.get_calls.append(kwargs)
        payloads = []
        for artifact_id in kwargs["artifact_ids"]:
            content = self._content(artifact_id)
            artifact = (
                _artifact(artifact_id, role="graph")
                if content is not None
                else self._reference(artifact_id)
            )
            if artifact is not None:
                payloads.append(replace(artifact, data=content))
        return tuple(payloads)


def _artifact(artifact_id: str, *, role: str) -> Artifact:
    return Artifact(
        id=artifact_id,
        project_id="proj_1",
        target_type="experiment",
        target_id="exp_1",
        role=role,
        attempt_index=2,
        lens_id="",
        path=f"{artifact_id}.json",
        title="",
        sha256=f"sha-{artifact_id}",
        size_bytes=1,
        content_type="application/json",
        status="complete",
        created_by="agent",
        created_at="2026-07-19T12:00:00Z",
        updated_at="2026-07-19T12:00:00Z",
        order=1,
    )


class LogicGraphTest(unittest.TestCase):
    def test_logic_graph_query_owns_selection_parsing_lint_and_ref_resolution(
        self,
    ) -> None:
        research = GraphResearch()
        artifacts = GraphArtifacts()
        query = LogicGraphQuery(research=research, artifacts=artifacts)

        result = query.experiment(project_id="proj_1", experiment_id="exp_1")

        self.assertTrue(result["available"])
        self.assertEqual(result["artifact_id"], "res_new")
        self.assertEqual(result["graph"]["nodes"][0]["label"], "New")
        self.assertEqual(result["problems"], [])
        self.assertEqual(
            result["ref_index"],
            {"claim_1": {"type": "claim", "resolved": True}},
        )
        self.assertEqual(
            research.resolved,
            [{"project_id": "proj_1", "refs": ("claim_1",)}],
        )
        self.assertEqual(
            [call["artifact_ids"] for call in artifacts.get_calls],
            [("res_new",)],
        )

    def test_logic_graph_query_composes_refs_in_first_seen_order(self) -> None:
        class MixedResearch(GraphResearch):
            def resolve_graph_refs(self, **kwargs):
                self.resolved.append(kwargs)
                return {
                    "claim_1": {"type": "claim", "resolved": True},
                    "exp_missing": {"type": "unknown", "resolved": False},
                }

        class MixedArtifacts(GraphArtifacts):
            def _content(self, artifact_id: str) -> bytes | None:
                if artifact_id == "res_new":
                    return (
                        b'{"version":1,"nodes":['
                        b'{"id":"a","label":"A","refs":'
                        b'["claim_1","art_results","claim_1","exp_missing"]},'
                        b'{"id":"b","label":"B","refs":'
                        b'["art_missing","ghost.json"," ",7]}]}'
                    )
                return None

            def _reference(self, artifact_id: str) -> Artifact | None:
                if artifact_id == "art_results":
                    return _artifact(artifact_id, role="result")
                return None

        research = MixedResearch()
        artifacts = MixedArtifacts()

        result = LogicGraphQuery(research=research, artifacts=artifacts).experiment(
            project_id="proj_1", experiment_id="exp_1"
        )

        self.assertEqual(
            list(result["ref_index"]),
            [
                "claim_1",
                "art_results",
                "exp_missing",
                "art_missing",
                "ghost.json",
            ],
        )
        self.assertEqual(
            result["ref_index"]["exp_missing"],
            {"type": "unknown", "resolved": False},
        )
        self.assertEqual(result["ref_index"]["art_results"]["type"], "artifact")
        self.assertFalse(result["ref_index"]["art_missing"]["resolved"])
        self.assertIn(
            "not a submitted artifact id",
            result["ref_index"]["ghost.json"]["hint"],
        )
        self.assertEqual(
            research.resolved,
            [
                {
                    "project_id": "proj_1",
                    "refs": (
                        "claim_1",
                        "art_results",
                        "exp_missing",
                        "art_missing",
                        "ghost.json",
                    ),
                }
            ],
        )
        self.assertEqual(
            [call["artifact_ids"] for call in artifacts.get_calls],
            [("res_new",), ("art_results", "art_missing")],
        )

    def test_graph_resolves_reused_content_by_its_workflow_association_handle(self) -> None:
        class AttachedArtifacts(GraphArtifacts):
            def _content(self, artifact_id: str) -> bytes | None:
                if artifact_id == "res_new":
                    return b'{"version":1,"nodes":[{"id":"n","label":"Evidence","refs":["artref_shared"]}]}'
                return None

            def _reference(self, artifact_id: str) -> Artifact | None:
                if artifact_id == "artref_shared":
                    return replace(_artifact(artifact_id, role="result"), artifact_id="art_content")
                return None

        result = LogicGraphQuery(
            research=GraphResearch(), artifacts=AttachedArtifacts()
        ).experiment(project_id="proj_1", experiment_id="exp_1")
        reference = result["ref_index"]["artref_shared"]
        self.assertTrue(reference["resolved"])
        self.assertEqual(reference["artifact_id"], "artref_shared")

    def test_project_graph_keeps_signal_when_no_reflection_exists(self) -> None:
        result = LogicGraphQuery(
            research=GraphResearch(), artifacts=GraphArtifacts()
        ).project(project_id="proj_1")

        self.assertEqual(
            result,
            {
                "max_nodes": 16,
                "signal": "stale",
                "available": False,
                "reflection": None,
                "graph": None,
                "problems": [],
            },
        )

    def test_project_graph_presents_semantic_reflection_signal(self) -> None:
        class SemanticSignalResearch(GraphResearch):
            def project_logic_graph_selection(self, **_kwargs):
                return {
                    "reflection": None,
                    "graph_resource": None,
                    "signal": {
                        "terminal_experiments": 3,
                        "covered_terminal_experiments": 0,
                        "new_terminal_since_publish": 3,
                        "claims_changed_since_publish": 0,
                        "contradicted_flip": False,
                        "last_published_reflection_id": None,
                        "stale": True,
                        "experiment_create_blocked": False,
                    },
                }

        result = LogicGraphQuery(
            research=SemanticSignalResearch(), artifacts=GraphArtifacts()
        ).project(project_id="proj_1")

        self.assertEqual(list(result["signal"])[-1], "hint")
        self.assertIn("first reflection", result["signal"]["hint"])

if __name__ == "__main__":
    unittest.main()
