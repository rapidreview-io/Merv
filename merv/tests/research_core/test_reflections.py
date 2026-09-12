from __future__ import annotations

import json
from merv.brain.research_core.reflections import _materialize_claim_changes
import unittest
from unittest import mock

from merv.brain.workflows.definitions.documents import decision_problems
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
    REVIEW_SYNOPSIS,
    VALID_CHANGE_SPEC,
    VALID_PROJECT_GRAPH,
    VALID_REFLECTION,
    ResearchCase,
)


class ReflectionWorkflowTest(ResearchCase):
    def test_direct_and_reflection_claims_share_fields_and_events(self):
        direct = self.app.research.create_claim(project_id=self.project_id, statement="  Compare the effect.  ", scope=" Local ")
        reflection = self.create_reflection()
        service = self.app.research.reflections
        with self.app.store.transaction() as conn:
            ids = _materialize_claim_changes(write_claim=self.app.research._write_claim, conn=conn, project_id=self.project_id, reflection_id=reflection,
                changes=[{"op": "create", "key": "effect", "statement": "  Compare the effect.  ", "scope": " Local ", "rationale": " Evidence "}])
            wave_id = ids["effect"]
            wave = dict(conn.execute("SELECT * FROM claims WHERE id = ?", (wave_id,)).fetchone())
            for field in ("statement", "scope", "status", "confidence"):
                self.assertEqual(wave[field], direct[field])
            events = [json.loads(row["payload_json"]) for row in conn.execute("SELECT payload_json FROM events WHERE target_type = 'claim' ORDER BY id").fetchall()]
            self.assertEqual(events[-1], {**events[0], "source_reflection_id": reflection, "rationale": "Evidence"})
            _materialize_claim_changes(write_claim=self.app.research._write_claim, conn=conn, project_id=self.project_id, reflection_id=reflection,
                changes=[{"op": "update", "claim_id": direct["id"], "statement": "Revised claim.", "status": "supported"}])
            updated = dict(conn.execute("SELECT * FROM claims WHERE id = ?", (direct["id"],)).fetchone())
            self.assertEqual((updated["statement"], updated["scope"], updated["confidence"], updated["status"]),
                             ("Revised claim.", "Local", "medium", "supported"))

    def test_reflection_claim_edits_reject_foreign_project_and_rollback_together(self):
        from merv.brain.kernel.utils import NotFoundError
        other = self.call("project", action="create", name="Foreign claims")["id"]
        foreign = self.app.research.create_claim(project_id=other, statement="Foreign claim.")
        reflection = self.create_reflection()
        changes = [{"op": "create", "key": "local", "statement": "Local claim."},
                   {"op": "update", "claim_id": foreign["id"], "status": "supported"}]
        def counts():
            with self.app.store.transaction() as conn:
                return [conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]
                        for table in ("claims", "events", "reflection_claim_changes")]
        before = counts()
        with self.assertRaises(NotFoundError), self.app.store.transaction() as conn:
            _materialize_claim_changes(write_claim=self.app.research._write_claim, conn=conn, project_id=self.project_id,
                reflection_id=reflection, changes=changes)
        self.assertEqual(counts(), before)
        with self.assertRaisesRegex(RuntimeError, "abort after association"), self.app.store.transaction() as conn:
            _materialize_claim_changes(write_claim=self.app.research._write_claim, conn=conn, project_id=self.project_id,
                reflection_id=reflection, changes=changes[:1])
            raise RuntimeError("abort after association")
        self.assertEqual(counts(), before)
        with self.assertRaises(NotFoundError):
            self.app.research.update_claim(project_id=self.project_id, claim_id=foreign["id"], status="supported")

    def _reserve_spec(self, *, experiments=True):
        spec = json.loads(VALID_CHANGE_SPEC)
        spec["decision"]["tasks"] = [{"key": "prep", "name": "prep-data", "goal": "Prepare data.",
                                      "done_when": ["The split counts are verified."]}]
        if not experiments:
            spec["decision"]["experiments"] = []
        reflection = self.create_reflection()
        self.submit_lenses(reflection)
        self.call("reflection.transition", project_id=self.project_id, reflection_id=reflection, transition="submit_reflections")
        self.submit_reflection_bundle(reflection, change_spec=json.dumps(spec))
        self.call("reflection.transition", project_id=self.project_id, reflection_id=reflection, transition="submit_reflection_artifacts")
        return reflection

    def test_task_only_reservations_leave_all_experiment_slots_available(self):
        self._reserve_spec(experiments=False)
        for index in range(ACTIVE_EXPERIMENT_CAP):
            self.call("experiment.create", project_id=self.project_id, name=f"fill-{index}", intent="Use an available slot.")
        with self.app.store.transaction() as conn:
            self.assertEqual(conn.execute("SELECT SUM(experiment_slots) AS n FROM reflection_reserved_names").fetchone()["n"], 0)

    def test_mixed_reservations_publish_at_capacity_from_pinned_spec(self):
        reflection = self._reserve_spec()
        self.pass_review(target_type="reflection", target_id=reflection, role="reflection_reviewer")
        advance = self._reviewed_no_code_advance(reflection)
        for index in range(ACTIVE_EXPERIMENT_CAP - 1):
            self.call("experiment.create", project_id=self.project_id, name=f"fill-{index}", intent="Use an available slot.")
        with self.assertRaises(WorkflowError):
            self.call("experiment.create", project_id=self.project_id, name="overflow", intent="Cannot steal the reserved slot.")
        with self.app.store.transaction() as conn:
            rows = [dict(row) for row in conn.execute("SELECT * FROM reflection_reserved_names ORDER BY name_lower").fetchall()]
        self.assertEqual([row["experiment_slots"] for row in rows], [0, 1])
        with self._flaky_materialization():
            with self.assertRaises(RuntimeError):
                self._settle(advance)
        with self.app.store.transaction() as conn:
            self.assertEqual([dict(row) for row in conn.execute("SELECT * FROM reflection_reserved_names ORDER BY name_lower").fetchall()], rows)
        # Publication must never fall back to the current spec after dropping its pin.
        with mock.patch.object(self.app.research.reflections, "_submitted_role_document", side_effect=AssertionError("lost pin")):
            self.assertEqual(self._settle(advance).status, "published")

    def test_migration_71_classifies_two_existing_names_and_keeps_unknown_safe(self):
        from merv.brain.research_core.persistence import RESEARCH_SCHEMA
        reflection = self._reserve_spec()
        self.pass_review(target_type="reflection", target_id=reflection, role="reflection_reviewer")
        with self.app.store.transaction() as conn:
            conn.execute("ALTER TABLE reflection_reserved_names DROP COLUMN experiment_slots")
            conn.execute("DELETE FROM schema_migrations WHERE version = 71")
        self.app.store.install(RESEARCH_SCHEMA)
        with self.app.store.transaction() as conn:
            self.assertEqual([r["experiment_slots"] for r in conn.execute("SELECT experiment_slots FROM reflection_reserved_names").fetchall()], [1, 1])
        self.app.research.reflections.classify_reservations()
        with self.app.store.transaction() as conn:
            self.assertEqual([r["experiment_slots"] for r in conn.execute("SELECT experiment_slots FROM reflection_reserved_names ORDER BY name_lower").fetchall()], [0, 1])
            conn.execute("INSERT INTO reflection_reserved_names (reflection_id, project_id, name_lower, artifact_id) VALUES (?, ?, 'unknown', 'missing')", (reflection, self.project_id))
        self.app.research.reflections.classify_reservations()
        with self.app.store.transaction() as conn:
            self.assertEqual(conn.execute("SELECT experiment_slots FROM reflection_reserved_names WHERE name_lower = 'unknown'").fetchone()["experiment_slots"], 1)

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
        with self.assertRaisesRegex(WorkflowError, "'amplify' lens's reflection_lens_doc"):
            self.call(
                "reflection.transition",
                project_id=self.project_id,
                reflection_id=reflection_id,
                transition="submit_reflections",
            )

        with self.assertRaisesRegex(ValidationError, "unknown lens_id 'zzz'"):
            self.submit(target_type="reflection", target_id=reflection_id, role="reflection_lens_doc",
                        path="reflections/zzz.md", lens_id="zzz", body="# zzz\n\n## Summary\nNot on the roster.")
        self.submit_lenses(reflection_id)
        synthesizing = self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="submit_reflections",
        )
        # A transition answers with a receipt, not the whole wave.
        self.assertEqual((synthesizing["from_status"], synthesizing["transition"]), ("reflecting", "submit_reflections"))
        self.assertLess(len(json.dumps(synthesizing)), 2000)
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
                SELECT COUNT(*) AS n FROM research_artifact_links
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
        with self.assertRaisesRegex(ValidationError, "transition: Input should be"):
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

        self.assertEqual(published.status, "published")
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
        self.assertEqual(len(published.materialized_claims), 2)
        self.assertEqual(len(published.materialized_experiments), 1)

    def _assert_publish_rollback(self, checkpoint):
        from contextlib import contextmanager
        existing = self.app.research.create_claim(project_id=self.project_id, statement="Existing belief.", scope="Keep this scope.")
        spec = json.loads(VALID_CHANGE_SPEC)
        spec["claim_changes"].append({"op": "update", "claim_id": existing["id"], "status": "supported",
                                      "confidence": "high", "rationale": "Reviewed evidence."})
        spec["decision"]["tasks"] = [
            {"key": "prep", "name": "prep-data", "goal": "Prepare data.", "done_when": ["Count the splits."]},
            {"key": "follow", "name": "inspect-transfer", "goal": "Inspect transfer.", "done_when": ["Inspect the report."],
             "depends_on": ["transfer_test"]}]
        spec["decision"]["experiments"][0]["depends_on"] = ["prep"]
        reflection = self.create_reflection()
        self.submit_lenses(reflection)
        self.call("reflection.transition", project_id=self.project_id, reflection_id=reflection, transition="submit_reflections")
        self.submit_reflection_bundle(reflection, change_spec=json.dumps(spec))
        self.call("reflection.transition", project_id=self.project_id, reflection_id=reflection, transition="submit_reflection_artifacts")
        self.pass_review(target_type="reflection", target_id=reflection, role="reflection_reviewer")
        advance = self._reviewed_no_code_advance(reflection)
        for index in range(ACTIVE_EXPERIMENT_CAP - 1):
            self.call("experiment.create", project_id=self.project_id, name=f"fill-{index}", intent="Use available capacity.")
        tables = ("reflections", "claims", "experiments", "tasks", "experiment_claims", "reflection_claim_changes",
                  "reflection_experiments", "reflection_tasks", "node_dependencies", "reflection_reserved_names",
                  "research_artifact_links", "research_submission_artifacts", "submissions",
                  "workflow_instances", "workflow_actions", "workflow_history", "events")
        def rows(conn):
            return {table: sorted((dict(row) for row in conn.execute(f"SELECT * FROM {table}").fetchall()),
                                  key=lambda row: json.dumps(row, sort_keys=True)) for table in tables}
        store, runtime = self.app.store, self.app.workflows.runtime
        with store.transaction() as conn:
            before = rows(conn)
        state = runtime.get(project_id=self.project_id, instance_id=reflection)
        self.assertEqual(sorted(row["experiment_slots"] for row in before["reflection_reserved_names"]), [0, 0, 1])
        self.assertEqual(state.state, "consolidation_review")
        fired = []
        prefix = {"claim_create": "INSERT INTO claims", "claim_update": "UPDATE claims SET",
                  "mixed_nodes": "INSERT INTO reflection_experiments", "dependencies": "INSERT INTO node_dependencies",
                  "history": "INSERT INTO workflow_history"}[checkpoint]
        case, transaction = self, store.transaction
        class FaultConnection:
            def __init__(self, conn):
                self.conn = conn
            def __getattr__(self, name):
                return getattr(self.conn, name)
            def execute(self, sql, parameters=()):
                result = self.conn.execute(sql, parameters)  # Fault only AFTER the real SQL write.
                if " ".join(sql.split()).startswith(prefix) and not fired:
                    if checkpoint == "history" and parameters[6] != "publish":
                        return result  # Node creation has its own earlier histories.
                    during = rows(self.conn)
                    saved = runtime.get(conn=self.conn, project_id=case.project_id, instance_id=reflection)
                    case.assertEqual((saved.state, saved.revision), ("published", state.revision + 1))
                    case.assertTrue(saved.data["published_graph_version_id"])
                    case.assertEqual(len(during["workflow_actions"]), len(before["workflow_actions"]) + 1)
                    case.assertEqual(len(during["claims"]), len(before["claims"]) + 1)
                    if checkpoint != "claim_create":
                        claim = next(row for row in during["claims"] if row["id"] == existing["id"])
                        case.assertEqual((claim["status"], claim["confidence"]), ("supported", "high"))
                    if checkpoint in {"mixed_nodes", "dependencies", "history"}:
                        for table, added in (("tasks", 2), ("experiments", 1), ("reflection_tasks", 2),
                                             ("reflection_experiments", 1), ("experiment_claims", 1)):
                            case.assertEqual(len(during[table]), len(before[table]) + added)
                    if checkpoint in {"dependencies", "history"}:
                        case.assertGreater(len(during["node_dependencies"]), len(before["node_dependencies"]))
                    if checkpoint == "history":
                        case.assertEqual(during["reflection_reserved_names"], [])
                        case.assertEqual(during["reflections"][0]["status"], "published")
                        case.assertEqual(during["reflections"][0]["published_graph_version_id"], saved.data["published_graph_version_id"])
                    else:
                        case.assertEqual(during["reflection_reserved_names"], before["reflection_reserved_names"])
                        case.assertEqual(during["reflections"], before["reflections"])
                    fired.append(checkpoint)
                    raise RuntimeError("after publication write")
                return result
        @contextmanager
        def failing_transaction():
            with transaction() as conn:
                yield FaultConnection(conn)
        with mock.patch.object(store, "transaction", failing_transaction):
            with self.assertRaisesRegex(RuntimeError, "after publication write"):
                self._settle(advance)
        self.assertEqual(fired, [checkpoint])
        with store.transaction() as conn:
            self.assertEqual(rows(conn), before)  # Includes pin, revision, native rows, slots, seals and every association.
        self.assertEqual(runtime.get(project_id=self.project_id, instance_id=reflection), state)
        self.assertEqual(self._advance_row(advance["id"])["status"], "bound")
        with mock.patch.object(self.app.research.reflections, "_submitted_role_document", side_effect=AssertionError("lost pin")):
            published = self._settle(advance)
        self.assertEqual((published.status, len(published.materialized_tasks), len(published.materialized_experiments)), ("published", 2, 1))
        self.assertEqual(self._advance_row(advance["id"])["error"], "")
        with store.transaction() as conn:
            committed = rows(conn)
            history = conn.execute("SELECT * FROM workflow_history WHERE instance_id = ? AND action = 'publish'", (reflection,)).fetchone()
            replay = runtime.apply_in_transaction(conn=conn, project_id=self.project_id, instance_id=reflection,
                action="publish", expected_revision=state.revision, request_id=history["command_key"].removeprefix("domain:"))
            self.assertEqual((replay.state, replay.revision), ("published", state.revision + 1))
        self._settle(advance)
        with store.transaction() as conn:
            self.assertEqual(rows(conn), committed)  # Both engine replay and bound-receipt retry are no-ops.
        self.assertEqual(committed["reflection_reserved_names"], [])
        self.assertEqual(len(committed["node_dependencies"]), 2)
        nodes = {row["proposal_key"]: row.get("task_id", row.get("experiment_id"))
                 for table in ("reflection_tasks", "reflection_experiments") for row in committed[table]}
        self.assertEqual({(row["node_id"], row["depends_on_id"]) for row in committed["node_dependencies"]},
                         {(nodes["follow"], nodes["transfer_test"]), (nodes["transfer_test"], nodes["prep"])})

    def test_publish_rolls_back_after_claim_creation(self):
        self._assert_publish_rollback("claim_create")

    def test_publish_rolls_back_after_claim_update(self):
        self._assert_publish_rollback("claim_update")

    def test_publish_rolls_back_after_mixed_node_creation(self):
        self._assert_publish_rollback("mixed_nodes")

    def test_publish_rolls_back_after_dependency_insertion(self):
        self._assert_publish_rollback("dependencies")

    def test_publish_rolls_back_after_reservation_deletion_and_history(self):
        self._assert_publish_rollback("history")

    def _reviewed_no_code_advance(self, reflection_id: str) -> dict:
        """Drive the consolidation gate to a prepared advance without settling."""
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
        return self.app.research.reflections.prepare_advance(
            project_id=self.project_id,
            reflection_id=reflection_id,
            runner_id="runner",
        )

    def _settle(self, advance: dict, runner_id: str = "runner") -> dict:
        return self.app.research.reflections.settle_advance(
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
                "SELECT status, error, bound_at FROM workspace_advances "
                "WHERE id = ?",
                (advance_id,),
            ).fetchone()
        return {key: row[key] for key in row.keys()}

    def _flaky_materialization(self):
        """Patch context: the first publish attempt fails, later ones succeed."""
        handlers = self.app.workflows.runtime.transactional_effects
        key = ("reflection", 1, "reflection.materialize_change_spec")
        original = handlers[key]
        calls = {"n": 0}

        def flaky(*args):
            original(*args)
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("transient publish failure")

        return mock.patch.dict(handlers, {key: flaky})

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
                ).status,
                "consolidating",
            )
            # Discovery hands the bound receipt back, and preparing it again
            # returns the same receipt instead of refusing, so the runner's
            # no-op advance retries the settle through the generic routes.
            pending = self.app.application.pending_agent_advance(project_id=self.project_id)
            self.assertIsNotNone(pending)
            assert pending is not None
            self.assertEqual(pending["advance_id"], advance["id"])
            self.assertEqual((pending["instance_id"], pending["expected_sha"], pending["target_sha"]),
                             (reflection_id, "1" * 40, "2" * 40))
            retried = self.app.application.prepare_agent_advance(
                project_id=self.project_id, instance_id=reflection_id, runner_id="another-runner",
            )
            self.assertEqual(retried, pending)
            published = self._settle(advance)
        self.assertEqual(published.status, "published")
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
                    "UPDATE workspace_advances SET bound_at = ? WHERE id = ?",
                    ("2026-08-08T00:00:00Z", advance["id"]),
                )
            published = self._settle(advance, runner_id="replacement")
        self.assertEqual(published.status, "published")

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
        self.assertEqual(published.status, "published")
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
        self.assertEqual(published.status, "published")

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
        self.assertEqual(published.status, "published")
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
        self.assertEqual(settled.status, "abandoned")
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
        self.assertEqual(published.status, "published")
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
        self.assertEqual(published.status, "published")
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
        self.assertEqual(published.status, "published")
        service = self.app.reflection_waves
        with mock.patch.object(
            service, "get_state", side_effect=RuntimeError("ack lost")
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

        experiment_id = str(published.materialized_experiments[0]["experiment_id"])
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
        signal = self.app.research_core.reflections.overview(project_id=self.project_id)[
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
        signal = self.app.research_core.reflections.overview(project_id=self.project_id)[
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
                INSERT INTO agent_workspaces (
                  instance_id, project_id, branch, base_sha, head_sha,
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
        self.assertEqual(proposed["proposal_revision"], 1)
        decision = self.call("reflection.get", project_id=self.project_id,
                             reflection_id=reflection_id)["consolidation"]["decisions"][0]
        self.assertEqual(decision["source_sha"], "a" * 40)
        self.assertEqual(decision["integration_outcome"], "applied")

        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="consolidation_reviewer",
        )
        advance = self.app.research.reflections.prepare_advance(
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
        published = self.app.research.reflections.settle_advance(
            project_id=self.project_id,
            advance_id=advance["id"],
            runner_id="runner",
            observed_sha="2" * 40,
            proposal_parents=["1" * 40],
            diffstat={"commit_count": 1, "files_changed": 1},
            ancestry={experiment_id: False},
        )
        self.assertEqual(published.status, "published")
        final = published.consolidation["decisions"][0]
        self.assertFalse(final["ancestry_verified"])
        self.assertEqual(final["integration_outcome"], "applied")

    def test_central_advance_owner_can_be_recovered_after_its_lease(self) -> None:
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
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
        first = self.app.research.reflections.prepare_advance(
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
            self.app.research.reflections.prepare_advance(
                project_id=self.project_id,
                reflection_id=reflection_id,
                runner_id="runner-b",
            )
        with self.app.store.transaction() as tx:
            tx.execute(
                """
                UPDATE workspace_advances
                SET intended_at = '2000-01-01T00:00:00Z'
                WHERE id = ?
                """,
                (first["id"],),
            )

        recovered = self.app.research.reflections.prepare_advance(
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
                INSERT INTO agent_workspaces (
                  instance_id, project_id, branch, base_sha, head_sha,
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
        advance = self.app.research.reflections.prepare_advance(
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
            self.app.research.reflections.settle_advance(
                **settle,
                ancestry={},
            )
        with self.assertRaisesRegex(ValidationError, "must be true"):
            self.app.research.reflections.settle_advance(
                **settle,
                ancestry={experiment_id: False},
            )

        published = self.app.research.reflections.settle_advance(
            **settle,
            ancestry={experiment_id: True},
        )
        self.assertEqual(published.status, "published")

    def test_consolidation_review_loops_without_reopening_reflection(self) -> None:
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
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
        native, gate = self.app.research.reflections.get_state_with_gate(
            project_id=self.project_id, reflection_id=reflection_id)
        self.assertEqual((native.status, native.workflow_state, gate.decision.public()["state"]),
                         ("consolidating", "consolidation_review", "consolidation_review"))
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
        self.assertIn("consolidation_reviewer returned needs_changes", state["revision_context"])
        self.assertNotIn(
            "reflecting",
            {transition["leads_to"] for transition in state["allowed_transitions"]},
        )
        # Only what reflection.transition accepts; publish and the revise_* returns are the graph's own.
        self.assertEqual({transition["transition"] for transition in state["allowed_transitions"]},
                         {"submit_consolidation", "abandon"})
        replaced = self.app.application.submit_consolidation(
            project_id=self.project_id,
            reflection_id=reflection_id,
            base_sha="1" * 40,
            proposal_sha="3" * 40,
            summary="The reviewer's repair landed in a new proposal.",
            validation={"tests": "passed"},
            decisions=[],
            producer_session_id="consolidator",
        )
        # Submitting the repair answers the revision request, so the wave stops
        # asking for it: the transition's declared commit column clears it.
        self.assertEqual((replaced["proposal_revision"], replaced["from_status"], replaced["status"]),
                         (2, "consolidating", "consolidating"))
        self.assertEqual(replaced["superseded_proposal_id"], state["consolidation"]["proposal"]["id"])
        self.assertEqual(self.call("reflection.get", project_id=self.project_id,
                                   reflection_id=reflection_id)["revision_context"], "")


class ConsolidationHandoffTest(ResearchCase):
    """After the code review passes, the wave belongs to the runner — and every
    message in the loop stays within its byte budget."""

    def test_a_passed_consolidation_review_hands_the_wave_to_the_runner(self) -> None:
        reflection_id = self.drive_reflection_to_review()
        request = self.call("review.request", project_id=self.project_id, target_type="reflection",
                            target_id=reflection_id, role="reflection_reviewer", producer_session_id="producer")
        session = self.call("review.start", review_request_id=request["review_request_id"],
                            reviewer_capability=request["reviewer_capability"], caller_session_id="reviewer")
        self.assertLess(len(json.dumps(session)) - len(json.dumps(session["submitted_artifacts"])), 3600)
        self.call("review.submit", review_session_id=session["review_session_id"], verdict="pass",
                  synopsis=REVIEW_SYNOPSIS)
        packet = self.app.application.consolidation(project_id=self.project_id, reflection_id=reflection_id)
        proposal = dict(base_sha="1" * 40, summary="No tracked source changed.", validation={},
                        producer_session_id="consolidator", decisions=[
                            {"experiment_id": item["id"], "disposition": "reviewed_not_used",
                             "rationale": "No promotable change.", "integration_kind": "none"}
                            for item in packet["experiments"]])
        submitted = self.app.application.submit_consolidation(
            project_id=self.project_id, reflection_id=reflection_id, proposal_sha="2" * 40, **proposal)
        self.assertEqual((submitted["status"], submitted["proposal_revision"]), ("consolidating", 1))
        self.assertNotIn("superseded_proposal_id", submitted)
        self.assertIn("review.request", submitted["next_action"])
        self.assertLess(len(json.dumps(submitted)), 2200)

        verdict = self.review(target_type="reflection", target_id=reflection_id,
                              role="consolidation_reviewer", verdict="pass", producer_session_id="consolidator")
        self.assertEqual(verdict["target"]["status_after"], "consolidating")
        self.assertIn("runner publishes", verdict["next_action"])
        state = self.call("reflection.get", project_id=self.project_id, reflection_id=reflection_id)
        checklist = state["gate_checklist"]
        self.assertTrue(next(item for item in checklist["items"] if item["role"] == "consolidation_reviewer")["satisfied"])
        self.assertEqual(checklist["transition"], "publish")
        self.assertNotIn("submissions", state)
        self.assertEqual(state["artifacts"], [])
        self.assertLess(len(json.dumps(state)), 11000)
        with self.assertRaisesRegex(WorkflowError, "already passed consolidation review"):
            self.call("reflection.transition", project_id=self.project_id, reflection_id=reflection_id,
                      transition="submit_consolidation")
        with self.assertRaisesRegex(WorkflowError, "not allowed from 'consolidation_review'; allowed: submit_consolidation, abandon"):
            self.call("reflection.transition", project_id=self.project_id, reflection_id=reflection_id,
                      transition="submit_reflections")


class ChangeSpecWaveDagTest(unittest.TestCase):
    """The spec's DAG typing: tasks follow anything; experiments never sit
    downstream of a sibling experiment, tasks in between included."""

    @staticmethod
    def _problems(experiments, tasks):
        problems: list[str] = []
        decision_problems(
            {
                "decision": {
                    "type": "create_experiments",
                    "experiments": experiments,
                    "tasks": tasks,
                }
            },
            problems=problems,
            claim_keys={},
        )
        return problems

    @staticmethod
    def _exp(key, depends_on=()):
        return {
            "key": key,
            "name": f"{key}-exp",
            "intent": f"Test what {key} tests.",
            "depends_on": list(depends_on),
        }

    @staticmethod
    def _task(key, depends_on=()):
        return {
            "key": key,
            "name": f"{key}-task",
            "goal": f"Do the {key} work.",
            "deliverables": ["one verifiable thing exists"],
            "depends_on": list(depends_on),
        }

    def test_experiment_directly_after_experiment_is_refused(self) -> None:
        problems = self._problems(
            [self._exp("first"), self._exp("second", ["first"])], []
        )
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("depends on experiment first", problems[0])
        self.assertIn("no sequential experiments in one wave", problems[0])

    def test_experiment_after_experiment_through_tasks_is_refused(self) -> None:
        problems = self._problems(
            [self._exp("first"), self._exp("second", ["wrap"])],
            [self._task("extract", ["first"]), self._task("wrap", ["extract"])],
        )
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("depends on experiment first", problems[0])
        self.assertIn("through wrap -> extract", problems[0])

    def test_tasks_follow_anything_and_experiments_follow_tasks(self) -> None:
        problems = self._problems(
            [self._exp("probe"), self._exp("after-prep", ["prep"])],
            [
                self._task("prep"),
                self._task("extract", ["probe"]),
                self._task("archive", ["extract", "prep"]),
            ],
        )
        self.assertEqual(problems, [])

    def test_prior_wave_experiment_ids_stay_lineage_not_dependency(self) -> None:
        problems = self._problems(
            [self._exp("probe", ["exp_000000000000"])], []
        )
        self.assertEqual(problems, [])


if __name__ == "__main__":
    import unittest

    unittest.main()
