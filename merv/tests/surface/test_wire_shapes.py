"""The public shapes are the spec: one seeded project, recorded key for key.

`tests/fixtures/wire_shapes.json` was captured from the hand-assembled
presenters. Every projection that replaces one has to reproduce it exactly, so
this test — not a per-function unit test of dict assembly — is what pins the
wire. Regenerate deliberately with `python -m tests.support.wire_shapes`.
"""

from __future__ import annotations

import json
import unittest

from tests.support.wire_shapes import FIXTURE, capture

# Two readers depend on where a key sits, not only on its presence: the agent
# reads the claim suggestions right after the gate they answer, and the
# post-publish guidance right after the experiments it talks about.
ADJACENT = (("gate_checklist", "claim_update_suggestions"),
            ("materialized_experiments", "post_publish_guidance"))


def _pairs(node, path="", found=None):
    """Every place an ordered pair's second key appears, with its predecessor."""
    found = [] if found is None else found
    if isinstance(node, dict):
        keys = list(node)
        for first, second in ADJACENT:
            if second in keys:
                index = keys.index(second)
                found.append((f"{path}.{second}", keys[index - 1] if index else "", first))
        for key, value in node.items():
            _pairs(value, f"{path}.{key}", found)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            _pairs(value, f"{path}[{index}]", found)
    return found


class WireShapeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.expected = json.loads(FIXTURE.read_text(encoding="utf-8"))
        cls.actual = capture()

    def test_every_route_and_tool_returns_the_recorded_shape(self) -> None:
        self.assertEqual(sorted(self.actual), sorted(self.expected))
        for name in self.expected:
            with self.subTest(shape=name):
                self.assertEqual(self.actual[name], self.expected[name])

    def test_the_two_order_sensitive_keys_keep_their_predecessor(self) -> None:
        pairs = _pairs(self.actual)
        self.assertTrue(pairs)
        for where, predecessor, expected in pairs:
            with self.subTest(at=where):
                self.assertEqual(predecessor, expected)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
