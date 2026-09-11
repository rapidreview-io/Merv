# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Cross-component read models shared by delivery surfaces."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from ..workflows import (
    MAX_GRAPH_NODES,
    PROJECT_GRAPH_ROLE,
    graph_problems,
    latest_per_slot,
    preferred_artifact,
)

from ..research_core import Artifact, Research, ResearchArtifacts as Artifacts
from .reflection_guidance import present_reflection_signal
from .reflections import present_reflection_state

Record = dict[str, Any]


@dataclass(slots=True)
class LogicGraphQuery:
    """Build the common logic-graph view from Research and Artifacts facts."""

    research: Research
    artifacts: Artifacts

    def experiment(self, *, project_id: str, experiment_id: str) -> Record:
        experiment = self.research.experiments.get_state(
            experiment_id=experiment_id, project_id=project_id
        )
        attempt = experiment.attempt_index
        # History, deliberately: the panel labels the graph with the attempt
        # that produced it, so the newest graph the experiment ever submitted
        # is an honest answer even after a rejection bumped the attempt.
        chosen = preferred_artifact(
            artifacts=latest_per_slot(experiment.artifacts),
            roles=("graph",),
        )
        base = {
            "experiment_id": experiment_id,
            "max_nodes": MAX_GRAPH_NODES,
            "experiment_status": experiment.status,
            "attempt_index": attempt,
        }
        if chosen is None:
            return {**base, "available": False, "graph": None, "problems": []}
        text = self._associated_text(chosen, project_id=project_id)
        if text is None:
            return {
                **base,
                "available": False,
                "graph": None,
                "problems": [
                    "graph has no submitted content — resubmit it via "
                    "artifact.upload (attach_to.role 'graph')"
                ],
                "path": chosen.get("path"),
            }
        return self._payload(base=base, chosen=chosen, text=text, project_id=project_id)

    def project(self, *, project_id: str) -> Record:
        selection = self.research.reflections.project_logic_graph_selection(project_id=project_id)
        return self._for_reflection(
            project_id=project_id,
            reflection=selection.get("reflection"),
            graph_artifact=selection.get("graph_artifact"),
            extra_base={"signal": present_reflection_signal(selection.get("signal"))},
        )

    def reflection_graph(self, *, project_id: str, reflection_id: str) -> Record:
        return self._for_reflection(
            project_id=project_id,
            reflection=present_reflection_state(
                self.research.reflections.get_state(
                    reflection_id=reflection_id, project_id=project_id
                )
            ),
        )

    def _for_reflection(
        self,
        *,
        project_id: str,
        reflection: Record | None,
        graph_artifact: Record | None = None,
        extra_base: Record | None = None,
    ) -> Record:
        base: Record = {"max_nodes": MAX_GRAPH_NODES, **(extra_base or {})}
        chosen = graph_artifact or (
            preferred_artifact(
                artifacts=reflection.get("current_attempt_artifacts") or [],
                roles=(PROJECT_GRAPH_ROLE,),
            )
            if reflection
            else None
        )
        if reflection is None or chosen is None:
            return {
                **base,
                "available": False,
                "reflection": None,
                "graph": None,
                "problems": [],
            }
        base["reflection"] = {
            "id": reflection.get("id"),
            "title": reflection.get("title"),
            "status": reflection.get("status"),
            "attempt_index": reflection.get("attempt_index"),
            "published_at": reflection.get("published_at"),
        }
        text = self._associated_text(chosen, project_id=project_id)
        if text is None:
            return {
                **base,
                "available": False,
                "graph": None,
                "problems": [
                    "graph has no submitted content — resubmit it via "
                    "artifact.upload (attach_to.role 'project_graph')"
                ],
                "path": chosen.get("path"),
            }
        return self._payload(base=base, chosen=chosen, text=text, project_id=project_id)

    def _payload(
        self,
        *,
        base: Record,
        chosen: Record,
        text: str,
        project_id: str,
    ) -> Record:
        graph: Record | None = None
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                graph = parsed
        except json.JSONDecodeError:
            pass
        return {
            **base,
            "available": True,
            "artifact_id": chosen.get("id"),
            "path": chosen.get("path"),
            "attempt_index": chosen.get("attempt_index"),
            "graph": graph,
            "problems": graph_problems(text),
            "ref_index": self._resolve_graph_refs(project_id=project_id, graph=graph),
        }

    def _associated_text(self, artifact: Record, *, project_id: str) -> str | None:
        artifact_id = str(artifact.get("id") or "")
        if not artifact_id:
            return None
        payloads = self.artifacts.get(
            artifact_ids=(artifact_id,),
            project_id=project_id,
            include="content",
        )
        data = payloads[0].data if payloads else None
        return data.decode("utf-8", errors="replace") if data is not None else None

    def _resolve_graph_refs(self, *, project_id: str, graph: Record | None) -> Record:
        refs = _refs_from_graph(graph)
        if not refs:
            return {}
        research = self.research.resolve_graph_refs(
            project_id=project_id, refs=tuple(refs)
        )
        artifact_ids = tuple(
            ref for ref in refs if ref.startswith(("art_", "artref_")) and ref not in research
        )
        artifacts = {
            artifact.id: artifact
            for artifact in (
                self.artifacts.get(
                    artifact_ids=artifact_ids,
                    project_id=project_id,
                )
                if artifact_ids
                else ()
            )
        }
        resolved: Record = {}
        for ref in refs:
            if ref in research:
                resolved[ref] = research[ref]
                continue
            artifact = artifacts.get(ref)
            resolved[ref] = (
                self._artifact_reference(artifact)
                if artifact is not None
                else {
                    "type": "unknown",
                    "resolved": False,
                    "hint": (
                        "not a submitted artifact id; submit the file with "
                        "artifact.upload to make this ref resolvable"
                    ),
                }
            )
        return resolved

    @staticmethod
    def _artifact_reference(artifact: Artifact) -> Record:
        return {
            "type": "artifact",
            "resolved": True,
            "artifact_id": artifact.id,
            "path": artifact.path,
            "role": artifact.role,
            "title": artifact.title,
        }


def _refs_from_graph(graph: Record | None) -> list[str]:
    refs: list[str] = []
    seen: set[str] = set()
    for node in (graph or {}).get("nodes") or []:
        if not isinstance(node, dict) or not isinstance(node.get("refs"), list):
            continue
        for ref in node["refs"]:
            if isinstance(ref, str) and ref.strip() and ref not in seen:
                seen.add(ref)
                refs.append(ref)
    return refs
