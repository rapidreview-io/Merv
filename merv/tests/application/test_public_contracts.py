"""Public state contracts independent of captured projects and volatile identifiers."""
from dataclasses import MISSING as NO_DEFAULT, fields, replace
import json
import unittest

from merv.brain.application.experiments.presentation import (
    AGENT as EXPERIMENT_AGENT, rich_experiment_state, slim_experiment_state,
)
from merv.brain.application.tasks import AGENT as TASK_AGENT, rich_task_state, slim_task_state
from merv.brain.application.reflections import present_reflection_state, present_agent_reflection_state
from merv.brain.research_core import EXPERIMENT, TASK, REFLECTION, public_record
from merv.brain.workflows import Public
from merv.brain.workflows.definitions.research_state import MISSING, ExperimentState, TaskState
from tests.support.research_state import experiment_state, task_state, reflection_state, review_reference

# Deliberate classifications: adding a native field must decide its wire contract.
COMMON = set("id project_id status attempt_index revision_context created_at updated_at artifacts "
             "current_attempt_artifacts submissions reviews allowed_transitions gate_checklist".split())
CASES = (
    (experiment_state, EXPERIMENT.public, EXPERIMENT_AGENT,
     COMMON | set("name intent conclusion details dependencies dependents tested_claims".split()), set()),
    (task_state, TASK.public, TASK_AGENT,
     COMMON | set("name goal outcome failed_by deliverables dependencies dependents".split()),
     {"results", "report", "caveats"}),
    (reflection_state, REFLECTION.public, REFLECTION.public,
     COMMON | set("title published_at published_graph_version_id created_seq roster corpus materialized_claims "
                  "materialized_experiments materialized_tasks consolidation reflection_coverage project_graph_diff".split()),
     {"snapshot_token", "code_sha"}),
)


def projections(state):
    if isinstance(state, ExperimentState):
        return (rich_experiment_state(state, storage_objects=[]), slim_experiment_state(state, storage_objects=[]))
    if isinstance(state, TaskState):
        return rich_task_state(state), slim_task_state(state)
    return present_reflection_state(state), present_agent_reflection_state(state)


class PublicStateContractTest(unittest.TestCase):
    def test_every_native_field_has_an_explicit_public_or_hidden_classification(self):
        for factory, public, agent, required, optional in CASES:
            state = factory()
            with self.subTest(state=type(state).__name__):
                self.assertFalse((required | optional) & set(public.hidden))
                self.assertEqual({field.name for field in fields(state)}, required | optional | set(public.hidden))
                for policy, output in zip((public, agent), projections(state)):
                    self.assertTrue(required - set(policy.hidden) <= output.keys())
                    self.assertFalse(set(policy.hidden) & output.keys())
                    self.assertFalse(optional & output.keys())
                self.assertEqual(set(public_record(public, state)), required)

    def test_omitting_any_required_field_fails_native_construction(self):
        for factory, *_ in CASES:
            state = factory()
            values = {field.name: getattr(state, field.name) for field in fields(state)}
            for field in fields(state):
                if field.default is NO_DEFAULT and field.default_factory is NO_DEFAULT:
                    with self.subTest(state=type(state).__name__, missing=field.name), self.assertRaises(TypeError):
                        type(state)(**{key: value for key, value in values.items() if key != field.name})
            with self.assertRaises(TypeError):
                type(state)(**values, undeclared_state=True)

    def test_hidden_fields_cannot_be_restored_by_computed_values_or_renaming(self):
        for factory, public, agent, *_ in CASES:
            for policy in (public, agent):
                state = factory()
                poison = dict.fromkeys(policy.hidden, "SECRET")
                renamed = Public(hidden=policy.hidden, renames={name: "leaked_" + name for name in policy.hidden})
                with self.subTest(state=type(state).__name__, hidden=policy.hidden):
                    serialized = json.dumps(public_record(renamed, state, **poison))
                    self.assertNotIn("SECRET", serialized)
                    self.assertNotIn("leaked_", serialized)

    def test_omission_is_distinct_from_null_and_nested_enums_are_wire_strings(self):
        absent = rich_task_state(task_state())
        detailed = rich_task_state(replace(task_state(), results=[], report=None, caveats=None))
        self.assertFalse({"results", "report", "caveats"} & absent.keys())
        self.assertEqual({key: detailed[key] for key in ("results", "report", "caveats")},
                         {"results": [], "report": None, "caveats": None})
        for state in (experiment_state(), task_state(), reflection_state()):
            state = replace(state, reviews=[review_reference()],
                            gate_checklist=replace(state.gate_checklist, transition=None, leads_to=None))
            rich, slim = projections(state)
            self.assertEqual(json.loads(json.dumps(rich)), rich)
            self.assertIs(type(rich["status"]), str)
            self.assertIs(type(rich["reviews"][0]["verdict"]), str)
            self.assertIsNone(rich["gate_checklist"]["transition"])
            self.assertNotIn("claim_update_suggestions", json.dumps((rich, slim)))
        self.assertEqual(public_record(Public(), {"omitted": MISSING, "null": None}), {"null": None})

    def test_published_guidance_is_adjacent_in_serialized_rich_and_agent_output(self):
        state = reflection_state(status="published", materialized_experiments=[{
            "id": "exp_next", "name": "next-test", "status": "planned", "parallelism": "serial"}])
        for output in projections(state):
            keys = list(json.loads(json.dumps(output)))
            self.assertEqual(keys[keys.index("materialized_experiments") + 1], "post_publish_guidance")
            self.assertTrue(output["post_publish_guidance"])
        for output in projections(reflection_state()):
            self.assertNotIn("post_publish_guidance", output)
