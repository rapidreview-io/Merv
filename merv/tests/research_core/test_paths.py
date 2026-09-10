"""Filesystem-safe experiment folder names."""

from __future__ import annotations

import unittest

from merv.brain.research_core import safe_experiment_dirname


class SafeExperimentDirnameTests(unittest.TestCase):
    def test_keeps_alphanumerics_dashes_underscores_and_dots(self) -> None:
        self.assertEqual(safe_experiment_dirname("exp_01.v2-b"), "exp_01.v2-b")

    def test_replaces_every_other_character(self) -> None:
        self.assertEqual(
            safe_experiment_dirname("lr sweep/2026:09 (a)"), "lr_sweep_2026_09__a_"
        )

    def test_empty_name_falls_back_to_experiment(self) -> None:
        self.assertEqual(safe_experiment_dirname(""), "experiment")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
