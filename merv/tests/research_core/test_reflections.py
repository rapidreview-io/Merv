from __future__ import annotations

import json
from unittest import mock

from merv.brain.kernel.utils import (
    PermissionDeniedError,
    ValidationError,
    WorkflowError,
)
from merv.brain.research_core.policy import (
    ACTIVE_EXPERIMENT_CAP,
    REFLECTION_BLOCK_NEW_TERMINAL_THRESHOLD,
)

from .scenarios import (
    LENSES,
    VALID_CHANGE_SPEC,
    VALID_PROJECT_GRAPH,
    VALID_REFLECTION,
    ResearchCase,
)


class ReflectionWorkflowTest(ResearchCase):
    def test_roster_and_single_open_wave_are_enforced(self) -> None:
        with self.assertRaisesRegex(ValidationError, "exactly 5 lenses"):
            self.call(
                "reflection.create",
                project_id=self.project_id,
                lenses=[dict(lens) for lens in LENSES[:4]],
            )
        reflection_id = self.create_reflection()
        with self.assertRaisesRegex(WorkflowError, "already open"):
            self.create_reflection("Second")
        abandoned = self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="abandon",
        )
        self.assertEqual(abandoned["status"], "abandoned")
        self.assertTrue(self.create_reflection("Replacement"))

    def test_lens_and_reconciliation_gates_require_the_declared_evidence(self) -> None:
        reflection_id = self.create_reflection()
        with self.assertRaises(WorkflowError):
            self.call(
                "reflection.transition",
                project_id=self.project_id,
                reflection_id=reflection_id,
                transition="submit_reflections",
            )

        self.submit_lenses(reflection_id)
        synthesizing = self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="submit_reflections",
        )
        self.assertEqual(synthesizing["status"], "synthesizing")

        roles = (
            ("project_graph", "project/logic_graph.json", VALID_PROJECT_GRAPH),
            ("reflection_doc", "project/reflection.md", VALID_REFLECTION),
            ("change_spec", "project/change_spec.json", VALID_CHANGE_SPEC),
        )
        for role, path, body in roles:
            with self.assertRaises(WorkflowError):
                self.call(
                    "reflection.transition",
                    project_id=self.project_id,
                    reflection_id=reflection_id,
                    transition="submit_reflection_artifacts",
                )
            self.submit(
                target_type="reflection",
                target_id=reflection_id,
                role=role,
                path=path,
                body=body,
            )
        reviewing = self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="submit_reflection_artifacts",
        )
        self.assertEqual(reviewing["status"], "reflection_review")
        with self.app.store.connect() as conn:
            sealed = conn.execute(
                """
                SELECT COUNT(*) AS n FROM artifacts
                WHERE target_id = ? AND submission_id <> ''
                """,
                (reflection_id,),
            ).fetchone()["n"]
        self.assertEqual(sealed, len(LENSES) + 3)

    def test_publish_materializes_reviewed_change_spec_atomically(self) -> None:
        existing = self.call(
            "claim.create",
            project_id=self.project_id,
            statement="The schedule effect is local.",
        )
        change_spec = json.loads(VALID_CHANGE_SPEC)
        change_spec["claim_changes"].insert(
            0,
            {
                "op": "update",
                "claim_id": existing["id"],
                "status": "supported",
                "confidence": "high",
                "rationale": "The reflection reconciled the evidence.",
            },
        )
        reflection_id = self.create_reflection()
        self.submit_lenses(reflection_id)
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="submit_reflections",
        )
        self.submit_reflection_bundle(
            reflection_id, change_spec=json.dumps(change_spec)
        )
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="submit_reflection_artifacts",
        )
        with self.assertRaises(WorkflowError):
            self.call(
                "reflection.transition",
                project_id=self.project_id,
                reflection_id=reflection_id,
                transition="publish",
            )
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        published = self.consolidate_and_publish(reflection_id)

        self.assertEqual(published["status"], "published")
        claims = self.call("claim.list", project_id=self.project_id)["claims"]
        self.assertEqual(
            {claim["statement"]: claim["status"] for claim in claims},
            {
                "The schedule effect is local.": "supported",
                "The schedule effect transfers.": "active",
            },
        )
        experiments = self.call("experiment.list", project_id=self.project_id)[
            "experiments"
        ]
        self.assertEqual(
            [(item["name"], item["status"]) for item in experiments],
            [("transfer-test", "planned")],
        )
        self.assertEqual(len(published["materialized_claims"]), 2)
        self.assertEqual(len(published["materialized_experiments"]), 1)

    def _reviewed_no_code_advance(self, reflection_id: str) -> dict:
        """Drive the consolidation gate to a prepared advance without settling."""
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="begin_consolidation",
        )
        packet = self.app.application.consolidation(
            project_id=self.project_id, reflection_id=reflection_id
        )
        self.app.application.submit_consolidation(
            project_id=self.project_id,
            reflection_id=reflection_id,
            base_sha="1" * 40,
            proposal_sha="2" * 40,
            summary="The reviewed research changes no tracked source files.",
            validation={"tests": "not_applicable"},
            decisions=[
                {
                    "experiment_id": experiment["id"],
                    "disposition": "reviewed_not_used",
                    "rationale": "No promotable source change.",
                    "integration_kind": "none",
                }
                for experiment in packet["experiments"]
            ],
            producer_session_id="consolidator",
        )
        self.review(
            target_type="reflection",
            target_id=reflection_id,
            role="consolidation_reviewer",
            verdict="pass",
            producer_session_id="consolidator",
        )
        return self.app.application.prepare_consolidation_advance(
            project_id=self.project_id,
            reflection_id=reflection_id,
            runner_id="runner",
        )

    def _settle(self, advance: dict, runner_id: str = "runner") -> dict:
        return self.app.application.settle_consolidation_advance(
            project_id=self.project_id,
            advance_id=advance["id"],
            runner_id=runner_id,
            observed_sha="2" * 40,
            proposal_parents=["1" * 40],
            diffstat={
                "commit_count": 0,
                "files_changed": 0,
                "insertions": 0,
                "deletions": 0,
            },
            ancestry={},
        )

    def _advance_row(self, advance_id: str) -> dict:
        with self.app.store.connect() as conn:
            row = conn.execute(
                "SELECT status, error, bound_at FROM reflection_advances "
                "WHERE id = ?",
                (advance_id,),
            ).fetchone()
        return {key: row[key] for key in row.keys()}

    def _flaky_materialization(self):
        """Patch context: the first publish attempt fails, later ones succeed."""
        service = self.app.reflection_waves
        original = service._materialize_change_spec
        calls = {"n": 0}

        def flaky(**kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("transient publish failure")
            return original(**kwargs)

        return mock.patch.object(
            service, "_materialize_change_spec", side_effect=flaky
        )

    def test_duplicate_claim_refs_are_rejected_at_the_review_gate(self) -> None:
        # Materialization inserts experiment_claims rows keyed on
        # (experiment_id, claim_id); a duplicate ref used to surface as an
        # IntegrityError at publish, stranding the wave. It is a domain
        # error at artifact submission now.
        change_spec = json.loads(VALID_CHANGE_SPEC)
        change_spec["decision"]["experiments"][0]["tested_claim_refs"] = [
            "transfer",
            "transfer",
        ]
        reflection_id = self.create_reflection()
        self.submit_lenses(reflection_id)
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="submit_reflections",
        )
        self.submit_reflection_bundle(
            reflection_id, change_spec=json.dumps(change_spec)
        )
        with self.assertRaisesRegex(WorkflowError, "duplicate claim reference"):
            self.call(
                "reflection.transition",
                project_id=self.project_id,
                reflection_id=reflection_id,
                transition="submit_reflection_artifacts",
            )

    def test_blocked_publish_keeps_the_bound_receipt_and_is_retryable(self) -> None:
        # The Git CAS happens before settle records it, so a publish failure
        # must never roll the 'bound' receipt back — the wave stays
        # consolidating, pending-work discovery surfaces the receipt, and a
        # retried settle (the runner's ordinary loop) completes the publish.
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        advance = self._reviewed_no_code_advance(reflection_id)
        with self._flaky_materialization():
            with self.assertRaisesRegex(RuntimeError, "transient publish failure"):
                self._settle(advance)
            row = self._advance_row(advance["id"])
            self.assertEqual(row["status"], "bound")
            self.assertIn("publish blocked after bind", row["error"])
            self.assertEqual(
                self.app.reflection_waves.get_state(
                    reflection_id=reflection_id, project_id=self.project_id
                )["status"],
                "consolidating",
            )
            # Discovery hands the receipt back so the runner retries settle.
            pending = self.app.application.pending_consolidation_advance(
                project_id=self.project_id
            )
            self.assertIsNotNone(pending)
            assert pending is not None
            self.assertEqual(pending["advance_status"], "bound")
            self.assertEqual(pending["advance_id"], advance["id"])
            self.assertEqual(pending["observed_sha"], "2" * 40)
            published = self._settle(advance)
        self.assertEqual(published["status"], "published")
        row = self._advance_row(advance["id"])
        self.assertEqual(row["status"], "bound")
        self.assertEqual(row["error"], "")  # no stale failure diagnostic
        with self.app.store.connect() as conn:
            reserved = conn.execute(
                "SELECT COUNT(*) AS n FROM reflection_reserved_names "
                "WHERE reflection_id = ?",
                (reflection_id,),
            ).fetchone()["n"]
        self.assertEqual(int(reserved), 0)

    def test_bound_publish_can_be_taken_over_after_the_owner_lease(self) -> None:
        # The CAS is never transferable, but completing a durable receipt's
        # blocked publish is: a replacement runner may settle once the
        # original owner's lease on the bound receipt has lapsed.
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        advance = self._reviewed_no_code_advance(reflection_id)
        with self._flaky_materialization():
            with self.assertRaisesRegex(RuntimeError, "transient publish failure"):
                self._settle(advance)
            with self.assertRaisesRegex(ValidationError, "another runner"):
                self._settle(advance, runner_id="replacement")
            with self.app.store.transaction() as conn:
                conn.execute(
                    "UPDATE reflection_advances SET bound_at = ? WHERE id = ?",
                    ("2026-08-08T00:00:00Z", advance["id"]),
                )
            published = self._settle(advance, runner_id="replacement")
        self.assertEqual(published["status"], "published")

    def test_wave_names_are_reserved_from_validation_onward(self) -> None:
        # A tool create that takes a validated spec's name mid-wave would
        # block the wave's publish at materialization; the reservation makes
        # the race an actionable error from the moment the spec is validated
        # (entry into reflection_review), not just once consolidation begins.
        reflection_id = self.drive_reflection_to_review()
        with self.assertRaisesRegex(WorkflowError, "reserved by reflection wave"):
            self.call(
                "experiment.create",
                project_id=self.project_id,
                name="transfer-test",
                intent="Race the wave during review.",
            )
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="begin_consolidation",
        )
        with self.assertRaisesRegex(WorkflowError, "reserved by reflection wave"):
            self.call(
                "experiment.create",
                project_id=self.project_id,
                name="transfer-test",
                intent="Race the wave.",
            )
        self.call(
            "experiment.create",
            project_id=self.project_id,
            name="unrelated-name",
            intent="A different name stays creatable.",
        )
        abandoned = self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="abandon",
        )
        self.assertEqual(abandoned["status"], "abandoned")
        released = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="transfer-test",
            intent="Released once the wave is gone.",
        )
        self.assertTrue(released["id"])

    def test_wave_reservation_holds_its_active_cap_slot(self) -> None:
        # The wave passed the cap check when its spec was validated; the
        # reservation holds that slot against tool creates, so publish lands
        # the wave at the cap instead of above it (and never wedges).
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        advance = self._reviewed_no_code_advance(reflection_id)
        for index in range(ACTIVE_EXPERIMENT_CAP - 1):
            self.call(
                "experiment.create",
                project_id=self.project_id,
                name=f"filler-{index}",
                intent="Occupy one active slot.",
            )
        with self.assertRaisesRegex(
            WorkflowError, "reserved by an in-flight reflection wave"
        ):
            self.call(
                "experiment.create",
                project_id=self.project_id,
                name="one-too-many",
                intent="The reserved slot is not consumable by tool creates.",
            )
        published = self._settle(advance)
        self.assertEqual(published["status"], "published")
        experiments = self.call("experiment.list", project_id=self.project_id)[
            "experiments"
        ]
        self.assertIn("transfer-test", {item["name"] for item in experiments})

    def test_abandon_is_refused_once_the_advance_is_bound(self) -> None:
        # Central already advanced: abandoning the wave would strand the
        # reviewed belief-state update forever, so the only exit is publish.
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        advance = self._reviewed_no_code_advance(reflection_id)
        with self._flaky_materialization():
            with self.assertRaisesRegex(RuntimeError, "transient publish failure"):
                self._settle(advance)
            with self.assertRaisesRegex(
                WorkflowError, "cannot be abandoned once bound"
            ):
                self.call(
                    "reflection.transition",
                    project_id=self.project_id,
                    reflection_id=reflection_id,
                    transition="abandon",
                )
            published = self._settle(advance)
        self.assertEqual(published["status"], "published")

    def test_consolidating_wave_refuses_late_artifact_submissions(self) -> None:
        # A new artifact mid-consolidation would reset review freshness and
        # block an already-bound publish at its gate; the wave's artifacts
        # freeze at begin_consolidation, and publish materializes the spec
        # pinned when its names were validated and reserved.
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        advance = self._reviewed_no_code_advance(reflection_id)
        late_spec = json.loads(VALID_CHANGE_SPEC)
        late_spec["decision"]["experiments"][0]["name"] = "sneaky-late-name"
        with self.assertRaisesRegex(ValidationError, "frozen while the wave"):
            self.submit(
                target_type="reflection",
                target_id=reflection_id,
                role="change_spec",
                path="project/change_spec.json",
                body=json.dumps(late_spec),
            )
        published = self._settle(advance)
        self.assertEqual(published["status"], "published")
        names = {
            item["name"]
            for item in self.call("experiment.list", project_id=self.project_id)[
                "experiments"
            ]
        }
        self.assertIn("transfer-test", names)
        self.assertNotIn("sneaky-late-name", names)

    def test_settle_after_abandon_records_an_orphaned_advance(self) -> None:
        # Abandon stays legal until a receipt binds; a CAS settled after the
        # wave closed must record an orphaned receipt, never bind into it.
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        advance = self._reviewed_no_code_advance(reflection_id)
        abandoned = self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="abandon",
        )
        self.assertEqual(abandoned["status"], "abandoned")
        settled = self._settle(advance)
        self.assertEqual(settled["status"], "abandoned")
        row = self._advance_row(advance["id"])
        self.assertEqual(row["status"], "stale")
        self.assertIn("orphaned", row["error"])
        experiments = self.call("experiment.list", project_id=self.project_id)[
            "experiments"
        ]
        self.assertNotIn("transfer-test", {item["name"] for item in experiments})

    def test_begin_consolidation_repins_a_rereviewed_spec(self) -> None:
        # A spec revised during reflection_review resets review freshness;
        # once the reviewer passes the revision, begin_consolidation re-pins
        # it so publication materializes what the reviewer approved.
        reflection_id = self.drive_reflection_to_review()
        revised = json.loads(VALID_CHANGE_SPEC)
        revised["decision"]["experiments"][0]["name"] = "revised-name"
        self.submit(
            target_type="reflection",
            target_id=reflection_id,
            role="change_spec",
            path="project/change_spec.json",
            body=json.dumps(revised),
        )
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        advance = self._reviewed_no_code_advance(reflection_id)
        published = self._settle(advance)
        self.assertEqual(published["status"], "published")
        names = {
            item["name"]
            for item in self.call("experiment.list", project_id=self.project_id)[
                "experiments"
            ]
        }
        self.assertIn("revised-name", names)
        self.assertNotIn("transfer-test", names)

    def test_prepin_wave_publishes_via_the_sealed_spec_fallback(self) -> None:
        # A wave already consolidating when the pin shipped has no
        # reservation rows; its bound publish falls back to the current
        # sealed spec instead of wedging.
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        advance = self._reviewed_no_code_advance(reflection_id)
        with self.app.store.transaction() as conn:
            conn.execute(
                "DELETE FROM reflection_reserved_names WHERE reflection_id = ?",
                (reflection_id,),
            )
        published = self._settle(advance)
        self.assertEqual(published["status"], "published")
        experiments = self.call("experiment.list", project_id=self.project_id)[
            "experiments"
        ]
        self.assertIn("transfer-test", {item["name"] for item in experiments})

    def test_ambiguous_commit_failure_leaves_no_stale_diagnostic(self) -> None:
        # An ambiguous COMMIT ack can surface an exception after publication
        # landed; the recovery handler must not write a blocked diagnostic
        # over a published wave.
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        advance = self._reviewed_no_code_advance(reflection_id)
        published = self._settle(advance)
        self.assertEqual(published["status"], "published")
        service = self.app.reflection_waves
        with mock.patch.object(
            service, "get_state_with_gate", side_effect=RuntimeError("ack lost")
        ):
            with self.assertRaisesRegex(RuntimeError, "ack lost"):
                service._publish_bound_advance(
                    advance_id=advance["id"],
                    reflection_id=reflection_id,
                    project_id=self.project_id,
                )
        row = self._advance_row(advance["id"])
        self.assertEqual(row["error"], "")

    def test_publish_materializes_experiment_without_tested_claims(self) -> None:
        change_spec = json.loads(VALID_CHANGE_SPEC)
        change_spec["claim_changes"] = []
        proposal = change_spec["decision"]["experiments"][0]
        proposal.pop("tested_claim_refs")
        proposal["name"] = "signal-probe"
        proposal["intent"] = "Probe a useful signal without a tracked claim."

        reflection_id = self.create_reflection("Claimless experiment")
        self.submit_lenses(reflection_id)
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="submit_reflections",
        )
        self.submit_reflection_bundle(
            reflection_id,
            change_spec=json.dumps(change_spec),
        )
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="submit_reflection_artifacts",
        )
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        published = self.consolidate_and_publish(reflection_id)

        experiment_id = str(published["materialized_experiments"][0]["experiment_id"])
        experiment = self.call(
            "experiment.get_state",
            project_id=self.project_id,
            experiment_id=experiment_id,
        )
        self.assertEqual(experiment["name"], "signal-probe")
        self.assertEqual(experiment["tested_claims"], [])

    def test_review_returns_preserve_or_reset_the_attempt_as_declared(self) -> None:
        same = self.drive_reflection_to_review("Same attempt")
        self.review(
            target_type="reflection",
            target_id=same,
            role="reflection_reviewer",
            verdict="needs_changes",
            return_to="synthesizing",
        )
        returned = self.call(
            "reflection.get",
            project_id=self.project_id,
            reflection_id=same,
        )
        self.assertEqual(
            (returned["status"], returned["attempt_index"]),
            ("synthesizing", 1),
        )

        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=same,
            transition="abandon",
        )
        reset = self.drive_reflection_to_review("New attempt")
        self.review(
            target_type="reflection",
            target_id=reset,
            role="reflection_reviewer",
            verdict="needs_changes",
            return_to="reflecting",
        )
        returned = self.call(
            "reflection.get",
            project_id=self.project_id,
            reflection_id=reset,
            include_content=True,
        )
        self.assertEqual(
            (returned["status"], returned["attempt_index"]),
            ("reflecting", 2),
        )
        self.assertEqual(
            set(returned["reflection_coverage"]["missing"]),
            {str(lens["id"]) for lens in LENSES},
        )

    def test_reviewer_snapshot_contains_each_lens_and_rejects_producer(self) -> None:
        reflection_id = self.drive_reflection_to_review()
        request = self.call(
            "review.request",
            project_id=self.project_id,
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
            producer_session_id="producer",
        )
        with self.assertRaises(PermissionDeniedError):
            self.call(
                "review.start",
                review_request_id=request["review_request_id"],
                reviewer_capability=request["reviewer_capability"],
                caller_session_id="producer",
            )
        session = self.call(
            "review.start",
            review_request_id=request["review_request_id"],
            reviewer_capability=request["reviewer_capability"],
            caller_session_id="reviewer",
        )
        lens_docs = [
            item
            for item in session["submitted_artifacts"]
            if item["role"] == "reflection_lens_doc"
        ]
        self.assertEqual(
            {item["lens_id"] for item in lens_docs},
            {str(lens["id"]) for lens in LENSES},
        )

    def test_reflection_signal_blocks_new_work_and_publish_resets_it(self) -> None:
        for index in range(REFLECTION_BLOCK_NEW_TERMINAL_THRESHOLD):
            experiment_id = self.create_experiment(f"finished-{index}")
            self.transition_experiment(experiment_id, "abandon")
        signal = self.app.research_core.reflection_overview(project_id=self.project_id)[
            "signal"
        ]
        self.assertTrue(signal["experiment_create_blocked"])
        with self.assertRaises(WorkflowError):
            self.create_experiment("blocked")

        reflection_id = self.drive_reflection_to_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        self.consolidate_and_publish(reflection_id)
        signal = self.app.research_core.reflection_overview(project_id=self.project_id)[
            "signal"
        ]
        self.assertFalse(signal["experiment_create_blocked"])
        self.assertEqual(signal["new_terminal_since_publish"], 0)

    def test_consolidation_records_every_branch_and_runner_verified_ancestry(
        self,
    ) -> None:
        experiment_id = self.create_experiment("code-producing-experiment")
        self.transition_experiment(experiment_id, "abandon")
        with self.app.store.transaction() as tx:
            tx.execute(
                """
                INSERT INTO experiment_workspaces (
                  experiment_id, project_id, branch, base_sha, head_sha,
                  commit_count, files_changed, insertions, deletions, updated_at
                )
                VALUES (?, ?, ?, ?, ?, 1, 1, 3, 1, ?)
                """,
                (
                    experiment_id,
                    self.project_id,
                    f"merv/experiments/{self.project_id}/{experiment_id}",
                    "1" * 40,
                    "a" * 40,
                    "2026-07-30T00:00:00Z",
                ),
            )
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="begin_consolidation",
        )
        proposed = self.app.application.submit_consolidation(
            project_id=self.project_id,
            reflection_id=reflection_id,
            base_sha="1" * 40,
            proposal_sha="2" * 40,
            summary="The useful change was rewritten into the central proposal.",
            validation={"tests": "passed"},
            decisions=[
                {
                    "experiment_id": experiment_id,
                    "disposition": "adapted",
                    "rationale": "The approach was retained with a smaller interface.",
                    "integration_kind": "rewrite",
                    "source_sha": "f" * 40,
                }
            ],
            producer_session_id="consolidator",
        )
        decision = proposed["consolidation"]["decisions"][0]
        self.assertEqual(decision["source_sha"], "a" * 40)
        self.assertEqual(decision["integration_outcome"], "applied")

        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="consolidation_reviewer",
        )
        advance = self.app.application.prepare_consolidation_advance(
            project_id=self.project_id,
            reflection_id=reflection_id,
            runner_id="runner",
        )
        self.assertEqual(
            advance["sources"],
            [
                {
                    "experiment_id": experiment_id,
                    "source_sha": "a" * 40,
                    "integration_kind": "rewrite",
                }
            ],
        )
        published = self.app.application.settle_consolidation_advance(
            project_id=self.project_id,
            advance_id=advance["id"],
            runner_id="runner",
            observed_sha="2" * 40,
            proposal_parents=["1" * 40],
            diffstat={"commit_count": 1, "files_changed": 1},
            ancestry={experiment_id: False},
        )
        self.assertEqual(published["status"], "published")
        final = published["consolidation"]["decisions"][0]
        self.assertFalse(final["ancestry_verified"])
        self.assertEqual(final["integration_outcome"], "applied")

    def test_central_advance_owner_can_be_recovered_after_its_lease(self) -> None:
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="begin_consolidation",
        )
        self.app.application.submit_consolidation(
            project_id=self.project_id,
            reflection_id=reflection_id,
            base_sha="1" * 40,
            proposal_sha="2" * 40,
            summary="No tracked source changed.",
            validation={"tests": "not_applicable"},
            decisions=[],
            producer_session_id="consolidator",
        )
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="consolidation_reviewer",
        )
        first = self.app.application.prepare_consolidation_advance(
            project_id=self.project_id,
            reflection_id=reflection_id,
            runner_id="runner-a",
        )
        with self.assertRaisesRegex(WorkflowError, "central advance"):
            self.app.application.submit_consolidation(
                project_id=self.project_id,
                reflection_id=reflection_id,
                base_sha="1" * 40,
                proposal_sha="3" * 40,
                summary="A replacement cannot race the in-flight advance.",
                validation={"tests": "passed"},
                decisions=[],
                producer_session_id="consolidator",
            )
        with self.assertRaisesRegex(WorkflowError, "owned by another runner"):
            self.app.application.prepare_consolidation_advance(
                project_id=self.project_id,
                reflection_id=reflection_id,
                runner_id="runner-b",
            )
        with self.app.store.transaction() as tx:
            tx.execute(
                """
                UPDATE reflection_advances
                SET intended_at = '2000-01-01T00:00:00Z'
                WHERE id = ?
                """,
                (first["id"],),
            )

        recovered = self.app.application.prepare_consolidation_advance(
            project_id=self.project_id,
            reflection_id=reflection_id,
            runner_id="runner-b",
        )

        self.assertEqual(recovered["id"], first["id"])
        self.assertEqual(recovered["runner_id"], "runner-b")
        self.assertEqual(recovered["status"], "intended")

    def test_merge_receipt_must_prove_source_ancestry(self) -> None:
        experiment_id = self.create_experiment("merged-experiment")
        self.transition_experiment(experiment_id, "abandon")
        with self.app.store.transaction() as tx:
            tx.execute(
                """
                INSERT INTO experiment_workspaces (
                  experiment_id, project_id, branch, base_sha, head_sha,
                  commit_count, files_changed, insertions, deletions, updated_at
                )
                VALUES (?, ?, 'merv/experiment', ?, ?, 1, 1, 1, 0, ?)
                """,
                (
                    experiment_id,
                    self.project_id,
                    "1" * 40,
                    "a" * 40,
                    "2026-07-30T00:00:00Z",
                ),
            )
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="begin_consolidation",
        )
        self.app.application.submit_consolidation(
            project_id=self.project_id,
            reflection_id=reflection_id,
            base_sha="1" * 40,
            proposal_sha="2" * 40,
            summary="The experiment branch was merged.",
            validation={"tests": "passed"},
            decisions=[
                {
                    "experiment_id": experiment_id,
                    "disposition": "used_as_is",
                    "rationale": "The change was accepted intact.",
                    "integration_kind": "merge",
                }
            ],
            producer_session_id="consolidator",
        )
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="consolidation_reviewer",
        )
        advance = self.app.application.prepare_consolidation_advance(
            project_id=self.project_id,
            reflection_id=reflection_id,
            runner_id="runner",
        )
        settle = dict(
            project_id=self.project_id,
            advance_id=advance["id"],
            runner_id="runner",
            observed_sha="2" * 40,
            proposal_parents=["1" * 40],
            diffstat={"commit_count": 1},
        )
        with self.assertRaisesRegex(ValidationError, "must cover every experiment"):
            self.app.application.settle_consolidation_advance(
                **settle,
                ancestry={},
            )
        with self.assertRaisesRegex(ValidationError, "must be true"):
            self.app.application.settle_consolidation_advance(
                **settle,
                ancestry={experiment_id: False},
            )

        published = self.app.application.settle_consolidation_advance(
            **settle,
            ancestry={experiment_id: True},
        )
        self.assertEqual(published["status"], "published")

    def test_consolidation_review_loops_without_reopening_reflection(self) -> None:
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="begin_consolidation",
        )
        self.app.application.submit_consolidation(
            project_id=self.project_id,
            reflection_id=reflection_id,
            base_sha="1" * 40,
            proposal_sha="2" * 40,
            summary="No tracked source changed.",
            validation={"tests": "not_applicable"},
            decisions=[],
            producer_session_id="consolidator",
        )
        self.review(
            target_type="reflection",
            target_id=reflection_id,
            role="consolidation_reviewer",
            verdict="needs_changes",
            return_to="consolidating",
        )
        state = self.call(
            "reflection.get",
            project_id=self.project_id,
            reflection_id=reflection_id,
        )
        self.assertEqual(state["status"], "consolidating")
        self.assertEqual(state["attempt_index"], 1)
        self.assertNotIn(
            "reflecting",
            {transition["leads_to"] for transition in state["allowed_transitions"]},
        )


if __name__ == "__main__":
    import unittest

    unittest.main()
