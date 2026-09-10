from __future__ import annotations

import unittest

from merv.brain.research_core.content_summaries import (
    MAX_CONTENT_TLDR_CHARS,
    content_tldr,
)


class ContentTldrTest(unittest.TestCase):
    def test_markdown_prefers_the_authored_summary_section(self) -> None:
        text = (
            "# Plan\n\nIntro that should not win.\n\n"
            "## Summary\n\n"
            "The compact answer uses [held-out data](https://example.test) "
            "and clears the baseline.\n\n"
            "## Evaluation\n" + ("Long detail. " * 200)
        )

        self.assertEqual(
            content_tldr(text, role="plan", path="plan.md"),
            "The compact answer uses held-out data and clears the baseline.",
        )

    def test_headingless_legacy_document_uses_opening_prose(self) -> None:
        text = "\n\n<!-- guidance -->\n# Lens\n\nFirst finding.\nSecond sentence.\n\n## Detail\nMore."

        self.assertEqual(
            content_tldr(text, role="reflection_lens_doc"),
            "First finding. Second sentence.",
        )

    def test_graph_json_summarizes_title_and_node_labels(self) -> None:
        text = (
            '{"version":1,"title":"Project state","nodes":['
            '{"id":"a","label":"One route survives"},'
            '{"id":"b","label":"Two baselines failed"}]}'
        )

        self.assertEqual(
            content_tldr(text, role="project_graph"),
            "Project state; One route survives; Two baselines failed",
        )

    def test_change_spec_json_summarizes_decision_counts_and_intents(self) -> None:
        text = (
            '{"version":1,"claim_changes":[{"op":"update"}],'
            '"decision":{"experiments":['
            '{"name":"first","intent":"Test the robust branch"},'
            '{"name":"second","intent":"Stress the surviving mechanism"}]}}'
        )

        self.assertEqual(
            content_tldr(text, role="change_spec"),
            "Proposes 2 experiments and 1 claim change: Test the robust branch; "
            "Stress the surviving mechanism",
        )

    def test_long_summary_is_single_line_word_bounded_and_capped(self) -> None:
        text = "## Summary\n" + ("substantive phrase " * 100)

        tldr = content_tldr(text)

        self.assertLessEqual(len(tldr), MAX_CONTENT_TLDR_CHARS)
        self.assertGreater(len(tldr), 500)
        self.assertTrue(tldr.endswith("…"))
        self.assertNotIn("\n", tldr)

    def test_absent_content_gets_an_explicit_nonempty_marker(self) -> None:
        self.assertEqual(
            content_tldr(None, role="report", path="reports/final.md"),
            "No submitted text is available for the report artifact at "
            "reports/final.md.",
        )

    def test_malformed_json_and_replacement_characters_are_safe(self) -> None:
        malformed = '{"summary": "broken"\ufffd\nFallback prose follows.'

        tldr = content_tldr(malformed, role="report")

        self.assertTrue(tldr)
        self.assertLessEqual(len(tldr), MAX_CONTENT_TLDR_CHARS)
        self.assertIn("Fallback prose follows.", tldr)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
