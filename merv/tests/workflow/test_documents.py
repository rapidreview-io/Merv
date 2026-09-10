"""Research documents are validated from their declared models.

One table drives the envelope cases: the model states the shape, so a breach is
reported by field path, and only the rules a schema cannot say — unique ids,
edges that resolve, a DAG — are written by hand and tested for their wording.
"""

from __future__ import annotations

import json
import unittest

from merv.brain.research_core.evidence import (
    GRAPH_SCHEMA_VERSION,
    MAX_GRAPH_BYTES,
    MAX_GRAPH_NODES,
    graph_problems,
)


def _graph(nodes, edges=None, version=GRAPH_SCHEMA_VERSION) -> str:
    return json.dumps({"version": version, "nodes": nodes, "edges": edges or []})


NODE = {"id": "obj", "kind": "objective", "label": "Reproduce the paper"}
OUTCOME = {"id": "out", "kind": "outcome", "label": "Matched within 0.3"}
BUDGET = [{"id": f"n{i}", "label": f"step {i}"} for i in range(MAX_GRAPH_NODES)]

# (case, graph text, every substring the problems must carry). An empty
# expectation means the document is accepted as written.
CASES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("minimal", _graph([NODE, OUTCOME], [{"from": "obj", "to": "out", "label": "confirmed by"}]), ()),
    # The envelope does not police node kinds, edge labels, statuses or unknown
    # fields — the story's design belongs to the agent.
    ("agent vocabulary", _graph(
        [
            {"id": "a", "kind": "rabbit hole", "label": "Chased a red herring", "mood": "regret"},
            {"id": "b", "kind": "breakthrough", "label": "Tokenizer was the culprit", "refs": ["rev_1"]},
        ],
        [{"from": "a", "to": "b", "label": "led, eventually, to"}],
    ), ()),
    ("full node budget", _graph(BUDGET), ()),
    ("edges optional", json.dumps({"version": 1, "nodes": [NODE]}), ()),
    ("not JSON", "{not json", ("not valid JSON",)),
    ("not an object", "[1, 2]", ("graph:",)),
    ("wrong version", _graph([NODE], version=2), ("graph.version",)),
    ("no nodes", json.dumps({"version": 1, "nodes": []}), ("graph.nodes",)),
    ("nodes missing", json.dumps({"version": 1}), ("graph.nodes",)),
    ("over budget", _graph([*BUDGET, {"id": "extra", "label": "one too many"}]),
     ("graph.nodes", f"at most {MAX_GRAPH_NODES}")),
    ("node shape", _graph([{"id": "a", "label": "A"}, {"id": "b"}, {"label": "no id"}, "not an object"]),
     ("graph.nodes[1].label", "graph.nodes[2].id", "graph.nodes[3]")),
    ("duplicate ids", _graph([{"id": "a", "label": "A"}, {"id": "a", "label": "A again"}]),
     ("duplicate node id: a",)),
    ("dangling edge", _graph([NODE, OUTCOME], [{"from": "obj", "to": "ghost"}]),
     ("edges[0] must reference existing node ids",)),
    ("self-loop", _graph([NODE], [{"from": "obj", "to": "obj"}]), ("edges[0] is a self-loop",)),
    ("oversized", _graph([{"id": "a", "label": "A", "detail": "x" * (MAX_GRAPH_BYTES + 100)}]),
     ("bytes",)),
    # Everything the same layer can see is reported in one pass.
    ("one pass", _graph([{"id": "a", "label": ""}, {"label": "no id"}], version=3),
     ("graph.version", "graph.nodes[0].label", "graph.nodes[1].id")),
)


class ProjectGraphDocumentTest(unittest.TestCase):
    def test_declared_envelope_accepts_and_refuses_by_field_path(self) -> None:
        for case, text, expected in CASES:
            with self.subTest(case=case):
                problems = graph_problems(text)
                if not expected:
                    self.assertEqual(problems, [])
                    continue
                joined = " | ".join(problems)
                for fragment in expected:
                    self.assertIn(fragment, joined)

    def test_budget_states_the_problem_without_prescribing_a_fix(self) -> None:
        # How to retell the story is the agent's call — no consolidation recipe.
        problems = graph_problems(_graph([*BUDGET, {"id": "x", "label": "y"}]))
        self.assertEqual(len(problems), 1)
        self.assertNotIn("collapse", problems[0].lower())
        self.assertNotIn("merge", problems[0].lower())

    def test_cycles_are_rejected_and_only_their_own_nodes_named(self) -> None:
        problems = graph_problems(
            _graph(
                [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}, {"id": "c", "label": "C"}],
                [{"from": "a", "to": "b"}, {"from": "b", "to": "c"}, {"from": "c", "to": "b"}],
            )
        )
        self.assertEqual(len(problems), 1)
        self.assertIn("cycle", problems[0])
        self.assertIn("b", problems[0])
        self.assertIn("c", problems[0])
        self.assertNotIn("a,", problems[0])


if __name__ == "__main__":
    unittest.main()
