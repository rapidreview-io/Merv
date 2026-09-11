"""Real persistence tests for graph plugins, composition, handoff and delivery."""

from __future__ import annotations

from dataclasses import replace

import unittest
from tempfile import TemporaryDirectory
from pathlib import Path

from tests.support.schema import booted_store
from merv.brain.kernel.utils import NotFoundError, WorkflowError
from merv.brain.workflows import (
    Action, Brief, Change, Child, Deliveries, Edge, Guidance, Issue, Node, Reference,
    Registry, Runtime, Workflow, wait_for_all, join_guard,
)


def brief(snapshot, knowledge):
    return Brief(f"Perform {snapshot.state} for {snapshot.data.get('purpose', 'this work')}.")


def worker(name):
    return Node(name, role="researcher", build_context=brief)


def replication():
    # A fourth workflow is just a graph, without a runtime or dispatcher branch.
    return Workflow(
        name="replication", version=1, initial="work",
        nodes=(worker("work"), worker("review")),
        edges=(
            Edge("work", "submit", "review"),
            Edge("review", "confirm", "confirmed"),
            Edge("review", "retry", "work"),
            Edge("review", "dispute", "disputed"),
        ),
        outcomes={"confirmed": "confirmed", "disputed": "disputed"},
        entries={"review_results": "review"},
    )


def act(runtime, project_id, snapshot, action, **kwargs):
    return runtime.apply(
        project_id=project_id, instance_id=snapshot.id, action=action,
        expected_revision=snapshot.revision, request_id=f"{snapshot.revision}:{action}", **kwargs,
    )


def wave():
    def route(snapshot, knowledge):
        if wait_for_all(snapshot, knowledge) is None:
            return None
        return "confirmed" if all(child.outcome == "confirmed" for child in snapshot.children) else "disputed"

    return Workflow(
        name="wave", version=1, initial="replicate",
        nodes=(
            Node("replicate", children=lambda snapshot, knowledge: (
                Child("first", "replication", entry="review_results"),
                Child("second", "replication", entry="review_results"),
            ), join=route),
            worker("reflect"), worker("revise"),
        ),
        edges=(Edge("replicate", "confirmed", "reflect", check=join_guard(route, "confirmed")),
               Edge("replicate", "disputed", "revise", check=join_guard(route, "disputed")),
               Edge("replicate", "restart", "replicate", suggest=False)),
        outcomes={"done": "published"},
    )


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp_path = Path(self.enterContext(TemporaryDirectory()))
        store = booted_store(self.tmp_path / "state.sqlite")
        with store.transaction() as conn:
            project_id = conn.execute("SELECT id FROM projects LIMIT 1").fetchone()["id"]
        runtime = Runtime(store=store, registry=Registry((replication(),)))
        self.system = runtime, project_id

    def test_branch_and_revision_loop_have_identical_transition_semantics(self):
        runtime, project_id = self.system
        current = runtime.start(project_id=project_id, workflow="replication", request_id="start")
        current = act(runtime, project_id, current, "submit")
        assert {action.edge.name for action in runtime.evaluate(project_id=project_id, instance_id=current.id).available} == {"confirm", "retry", "dispute"}
        current = act(runtime, project_id, current, "retry")
        current = act(runtime, project_id, current, "submit")
        current = act(runtime, project_id, current, "dispute")
        assert (current.state, current.outcome, current.revision) == ("disputed", "disputed", 4)
        assert runtime.evaluate(project_id=project_id, instance_id=current.id).actions == ()
        with self.assertRaisesRegex(WorkflowError, "not allowed"):
            act(runtime, project_id, current, "retry")
        with self.assertRaises(NotFoundError):
            runtime.get(project_id="some-other-project", instance_id=current.id)

    def test_checked_branch_uses_durable_facts_for_guidance_and_enforcement(self):
        runtime, project_id = self.system
        facts = {"approved": False}

        class Knowledge:
            def read(self, reference):
                assert reference == Reference("review", "review-1")
                return facts

        def approved(snapshot, knowledge):
            if not knowledge.read(Reference("review", "review-1"))["approved"]:
                return Issue("review_required", "The independent review must pass.", "request_review", ("review.request",))

        runtime.knowledge = lambda snapshot, conn: Knowledge()
        runtime.registry.register(Workflow(
            name="checked", version=1, initial="work", nodes=(worker("work"),),
            edges=(Edge("work", "revise", "work", suggest=False), Edge("work", "approve", "done", check=approved)),
            outcomes={"done": "success"},
        ))
        current = runtime.start(project_id=project_id, workflow="checked", request_id="checked")
        result = runtime.evaluate(project_id=project_id, instance_id=current.id)
        assert [action.edge.name for action in result.available] == ["revise"]
        assert result.public()["blocked_actions"][0]["blockers"][0]["code"] == "review_required"
        assert result.suggested.edge.name == "approve"
        with self.assertRaisesRegex(WorkflowError, "independent review must pass") as error:
            act(runtime, project_id, current, "approve", payload={"approved": True})
        assert error.exception.details["issues"] == result.public()["blocked_actions"][0]["blockers"]
        facts["approved"] = True
        assert act(runtime, project_id, current, "approve").outcome == "success"

    def test_idempotent_transition_rejects_changed_commands_and_preserves_one_effect(self):
        runtime, project_id = self.system
        definition = Workflow(
            name="effect", version=1, initial="work", nodes=(worker("work"),),
            edges=(Edge("work", "finish", "done", change=lambda snapshot, payload, knowledge: Change(actions=(Action("notify", {"value": 3}),))),),
            outcomes={"done": "success"},
        )
        runtime.registry.register(definition)
        current = runtime.start(project_id=project_id, workflow="effect", request_id="effect")
        finished = act(runtime, project_id, current, "finish")
        assert act(runtime, project_id, current, "finish") == finished
        with self.assertRaisesRegex(WorkflowError, "different workflow action"):
            act(runtime, project_id, current, "finish", payload={"changed": True})
        with runtime.store.transaction() as conn:
            assert conn.execute("SELECT COUNT(*) AS n FROM workflow_actions").fetchone()["n"] == 1
        assert [entry["action"] for entry in runtime.history(project_id=project_id, instance_id=current.id)] == ["start", "finish"]

    def test_failed_history_write_rolls_back_state_and_requested_actions(self):
        runtime, project_id = self.system
        runtime.registry.register(Workflow(
            name="atomic", version=1, initial="work", nodes=(worker("work"),),
            edges=(Edge("work", "finish", "done", change=lambda snapshot, payload, knowledge: Change(actions=(Action("retain"),))),),
            outcomes={"done": "success"},
        ))
        current = runtime.start(project_id=project_id, workflow="atomic", request_id="atomic")

        def broken(*args, **kwargs):
            raise RuntimeError("history unavailable")

        self.enterContext(unittest.mock.patch.object(runtime, "_record", broken))
        with self.assertRaisesRegex(RuntimeError, "history unavailable"):
            act(runtime, project_id, current, "finish")
        assert runtime.get(project_id=project_id, instance_id=current.id) == current
        with runtime.store.transaction() as conn:
            assert conn.execute("SELECT COUNT(*) AS n FROM workflow_actions").fetchone()["n"] == 0

    def test_definition_versions_are_pinned_until_explicit_migration(self):
        runtime, project_id = self.system
        current = runtime.start(project_id=project_id, workflow="replication", request_id="old")
        version2 = replace(replication(), version=2, initial="review")
        runtime.registry.register(version2)
        assert runtime.evaluate(project_id=project_id, instance_id=current.id).snapshot.version == 1
        newer = runtime.start(project_id=project_id, workflow="replication", request_id="new")
        assert (newer.version, newer.state) == (2, "review")
        with self.assertRaisesRegex(ValueError, "publish a new version"):
            runtime.registry.register(replace(version2, initial="work"))
        with self.assertRaises(TypeError):
            version2.outcomes["confirmed"] = "different"
        migrated = runtime.migrate(
            project_id=project_id, instance_id=current.id, version=2, expected_revision=0,
            request_id="upgrade", transform=lambda snapshot: ("review", Change({"migration_note": "Retained existing results."})),
        )
        assert (migrated.version, migrated.state, migrated.revision) == (2, "review", 1)
        assert migrated.data["migration_note"] == "Retained existing results."
        with self.assertRaisesRegex(WorkflowError, "changed"):
            act(runtime, project_id, current, "submit")

    def test_node_context_uses_exact_references_and_dispatch_rechecks_revision(self):
        runtime, project_id = self.system

        def context(snapshot, knowledge):
            return Brief("Review the pinned result for this attempt.", (Reference("artifact", snapshot.data["result_id"], "Submitted result"),))

        definition = replace(replication(), nodes=(worker("work"), Node("review", role="reviewer", build_context=context, guidance=Guidance(handoff="Review, then hand off and exit."))))
        runtime.registry = Registry((definition,))
        current = runtime.start(
            project_id=project_id, workflow="replication", request_id="review", entry="review_results",
            data={"result_id": "artifact-original"},
        )
        packet = runtime.assignment(project_id=project_id, instance_id=current.id)
        assert packet["references"] == [{"kind": "artifact", "id": "artifact-original", "label": "Submitted result"}]
        assert packet["revision"] == 0
        assert "hand off and exit" in packet["handoff"]
        act(runtime, project_id, current, "retry")
        with runtime.store.transaction() as conn, self.assertRaisesRegex(WorkflowError, "stale"):
            runtime.require_assignment(conn=conn, project_id=project_id, instance_id=current.id, revision=packet["revision"])
        with self.assertRaises(TypeError):
            current.data["result_id"] = "another-result"

    def test_dispatch_prerequisites_do_not_invent_an_extra_workflow_state(self):
        runtime, project_id = self.system
        dependencies = {"done": False}

        def dependencies_done(snapshot, knowledge):
            if not dependencies["done"]:
                return Issue("dependencies_pending", "Wait for the dataset task.")

        definition = Workflow(
            name="experiment_example", version=1, initial="design_review",
            nodes=(worker("design_review"), Node("execution", role="executor", build_context=brief, dispatch_check=dependencies_done)),
            edges=(Edge("design_review", "approve", "execution"), Edge("execution", "submit", "done")),
            outcomes={"done": "completed"},
        )
        runtime.registry.register(definition)
        current = runtime.start(project_id=project_id, workflow=definition.name, request_id="execution")
        current = act(runtime, project_id, current, "approve")
        assert current.state == "execution"
        assert not runtime.evaluate(project_id=project_id, instance_id=current.id).dispatchable
        with self.assertRaisesRegex(WorkflowError, "dataset task"):
            runtime.assignment(project_id=project_id, instance_id=current.id)
        dependencies["done"] = True
        assert runtime.assignment(project_id=project_id, instance_id=current.id)["role"] == "executor"

    def test_parent_waits_for_every_child_and_routes_named_outcomes(self):
        runtime, project_id = self.system
        runtime.registry.register(wave())
        parent = runtime.start(project_id=project_id, workflow="wave", request_id="wave")
        assert len(parent.children) == 2
        first, second = (runtime.get(project_id=project_id, instance_id=child.id) for child in parent.children)
        act(runtime, project_id, first, "confirm")
        assert runtime.get(project_id=project_id, instance_id=parent.id).state == "replicate"
        act(runtime, project_id, second, "dispute")
        assert runtime.get(project_id=project_id, instance_id=parent.id).state == "revise"
        assert [entry["action"] for entry in runtime.history(project_id=project_id, instance_id=parent.id)] == ["start", "disputed"]

    def test_previous_wave_children_cannot_resume_the_new_wait(self):
        runtime, project_id = self.system
        runtime.registry.register(wave())
        parent = runtime.start(project_id=project_id, workflow="wave", request_id="generations")
        old_children = parent.children
        act(runtime, project_id, parent, "restart")
        restarted = runtime.get(project_id=project_id, instance_id=parent.id)
        assert {child.id for child in old_children}.isdisjoint({child.id for child in restarted.children})
        for child in old_children:
            current = runtime.get(project_id=project_id, instance_id=child.id)
            act(runtime, project_id, current, "confirm")
        assert runtime.get(project_id=project_id, instance_id=parent.id).state == "replicate"
        for child in restarted.children:
            current = runtime.get(project_id=project_id, instance_id=child.id)
            act(runtime, project_id, current, "confirm")
        assert runtime.get(project_id=project_id, instance_id=parent.id).state == "reflect"

    def test_start_retry_does_not_duplicate_children_or_follow_a_new_default_version(self):
        runtime, project_id = self.system
        runtime.registry.register(wave())
        parent = runtime.start(project_id=project_id, workflow="wave", request_id="same-start")
        runtime.registry.register(replace(wave(), version=2))
        replay = runtime.start(project_id=project_id, workflow="wave", request_id="same-start")
        assert replay == parent
        with self.assertRaisesRegex(WorkflowError, "different workflow start"):
            runtime.start(project_id=project_id, workflow="wave", request_id="same-start", data={"different": True})

    def test_delivery_retry_uses_stable_key_and_stale_worker_cannot_settle(self):
        runtime, project_id = self.system
        runtime.registry.register(Workflow(
            name="delivery", version=1, initial="work", nodes=(worker("work"),),
            edges=(Edge("work", "finish", "done", change=lambda snapshot, payload, knowledge: Change(actions=(Action("save", {"value": 1}),))),),
            outcomes={"done": "done"},
        ))
        current = runtime.start(project_id=project_id, workflow="delivery", request_id="delivery")
        act(runtime, project_id, current, "finish")
        deliveries = Deliveries(store=runtime.store)
        first = deliveries.claim(project_id=project_id)
        assert first is not None
        # A worker performed the effect but died before acknowledging it.
        retained = {first.id: dict(first.data)}
        with runtime.store.transaction() as conn:
            conn.execute("UPDATE workflow_actions SET lease_until = '' WHERE id = ?", (first.id,))
        second = deliveries.claim(project_id=project_id)
        assert second.id == first.id and second.lease_token != first.lease_token
        assert second.attempts == 2
        retained.setdefault(second.id, dict(second.data))
        assert len(retained) == 1
        assert not deliveries.settle(first)
        assert deliveries.settle(second)
        assert deliveries.claim(project_id=project_id) is None

    def test_parent_version_migration_preserves_children_and_historical_membership(self):
        runtime, project_id = self.system
        runtime.registry.register(wave())
        parent = runtime.start(project_id=project_id, workflow="wave", request_id="pin-children")
        child_ids = {child.id for child in parent.children}
        first = runtime.get(project_id=project_id, instance_id=parent.children[0].id)
        act(runtime, project_id, first, "confirm")
        runtime.registry.register(replace(wave(), version=2))
        transform = lambda snapshot: ("replicate", Change({"upgrade": "Preserve this wave"}))
        with self.assertRaisesRegex(WorkflowError, "explicitly preserve"):
            runtime.migrate(project_id=project_id, instance_id=parent.id, version=2,
                            expected_revision=0, request_id="upgrade", transform=transform)
        with self.assertRaisesRegex(WorkflowError, "active children"):
            runtime.migrate(project_id=project_id, instance_id=parent.id, version=2,
                            expected_revision=0, request_id="upgrade", transform=transform, preserve_children=False)
        after = runtime.migrate(project_id=project_id, instance_id=parent.id, version=2,
                                expected_revision=0, request_id="upgrade", transform=transform, preserve_children=True)
        assert after.version == 2 and {child.id for child in after.children} == child_ids
        assert {child.id for child in after.children if child.outcome} == {first.id}
        status = runtime.evaluate(project_id=project_id, instance_id=parent.id).public()
        assert {child["instance_id"] for child in status["children"]} == child_ids
        with self.assertRaisesRegex(WorkflowError, "declared child outcomes"):
            act(runtime, project_id, after, "disputed")
        second = runtime.get(project_id=project_id, instance_id=parent.children[1].id)
        act(runtime, project_id, second, "confirm")
        assert runtime.get(project_id=project_id, instance_id=parent.id).state == "reflect"
        history = runtime.history(project_id=project_id, instance_id=parent.id)
        assert {child["id"] for child in history[0]["after"]["children"]} == child_ids
        assert {child["id"] for child in history[1]["after"]["children"]} == child_ids
        assert not any(child["outcome"] for child in history[0]["after"]["children"])

    def test_existing_child_composition_preserves_revision_and_rejects_second_parent(self):
        runtime, project_id = self.system
        child = runtime.start(project_id=project_id, workflow="replication", request_id="existing")
        child = act(runtime, project_id, child, "submit")
        definition = Workflow(
            name="attach", version=1, initial="wait",
            nodes=(Node("wait", children=lambda snapshot, knowledge: (
                Child("prior-work", "replication", instance_id=child.id),), join=wait_for_all),),
            edges=(Edge("wait", "children_finished", "done", check=join_guard(wait_for_all, "children_finished")),),
            outcomes={"done": "joined"},
        )
        runtime.registry.register(definition)
        parent = runtime.start(project_id=project_id, workflow="attach", request_id="attach")
        assert runtime.get(project_id=project_id, instance_id=child.id) == child
        assert parent.children[0].id == child.id
        with self.assertRaisesRegex(WorkflowError, "another workflow wait"):
            runtime.start(project_id=project_id, workflow="attach", request_id="duplicate-parent")
        act(runtime, project_id, child, "confirm")
        assert runtime.get(project_id=project_id, instance_id=parent.id).outcome == "joined"

    def test_idempotency_conflict_is_checked_before_support_preparation(self):
        from merv.brain.workflows import Program, Workflows
        runtime, project_id = self.system
        workflows = Workflows(store=runtime.store, programs=(Program(name="test", version=1, workflows=(replication(),)),))
        preparations = []
        workflows.register_preparation("replication", lambda snapshot, action, payload: preparations.append(action))
        started = workflows.start(project_id=project_id, workflow="replication", request_id="start")
        command = dict(project_id=project_id, instance_id=started["id"], action="submit", expected_revision=0, request_id="transition")
        accepted = workflows.transition(**command)
        assert workflows.transition(**command) == accepted
        assert preparations == ["submit"]
        with self.assertRaisesRegex(WorkflowError, "different workflow action"):
            workflows.transition(**{**command, "action": "retry", "expected_revision": 1})
        with self.assertRaisesRegex(WorkflowError, "request id"):
            workflows.transition(**{**command, "action": "retry", "expected_revision": 1, "request_id": ""})
        assert preparations == ["submit"]
