from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from pydantic import ValidationError as PydanticValidationError

from tests.support.brain import TestBrain
from merv.brain.kernel.utils import PermissionDeniedError
from merv.brain.surface.config import STORAGE_PROVIDER_ENV_VAR
from merv.brain.surface.tools.contracts import (
    MCP_HIDDEN_TOOL_NAMES,
    ArtifactFindInput,
    ArtifactSubmitInput,
    MlflowFinalizeRunInput,
    ReflectionGetInput,
    SandboxExtendInput,
    SandboxPullOutputsInput,
    SandboxRequestInput,
    StorageCompleteUploadInput,
    StorageFetchInput,
    StorageFindInput,
    StorageObjectInput,
    StoragePutObjectInput,
    StorageSubmitInput,
    STORAGE_TOOL_NAMES,
    TOOL_CONTRACTS,
    TOOL_MANIFEST,
    available_tool_names,
)
from tests.support.sandbox_backend import FakeSandboxBackend
from merv.brain.surface.tools.dispatcher import ToolDispatcher


BASE_PUBLIC_TOOLS = frozenset(
    {
        "artifact.find",
        "artifact.submit",
        "candidate.list",
        "candidate.promote",
        "candidate.stage",
        "candidate.submit",
        "claim.create",
        "claim.update",
        "consolidation.get",
        "consolidation.submit",
        "experiment.create",
        "experiment.exhibit",
        "experiment.transition",
        "feed.list",
        "feed.post",
        "feed.register",
        "litreview.cite",
        "litreview.edit",
        "litreview.view",
        "project",
        "reflection.create",
        "reflection.get",
        "reflection.transition",
        "review.request",
        "review.start",
        "review.submit",
        "sandbox.attach",
        "sandbox.extend",
        "sandbox.get",
        "sandbox.list",
        "sandbox.options",
        "sandbox.pull_outputs",
        "sandbox.release",
        "sandbox.request",
        "sandbox.runs",
        "sandbox.terminal",
        "workflow.status_and_next",
    }
)
BASE_INTERNAL_TOOLS = frozenset(
    {
        "claim.list",
        "experiment.get_state",
        "experiment.list",
        "project.get",
        "project.list",
        "project.update",
        "reflection.list",
        "review.status",
        "sandbox.health",
    }
)
STORAGE_PUBLIC_TOOLS = frozenset(
    {"storage.fetch", "storage.find", "storage.object", "storage.submit"}
)
STORAGE_INTERNAL_TOOLS = frozenset({"storage.complete_upload", "storage.put_object"})
TRACKING_PUBLIC_TOOLS = frozenset({"mlflow.context", "mlflow.finalize_run"})

# Normalized Pydantic schemas: prose and non-semantic ordering are deliberately
# excluded, while fields, requiredness, unions, enums, defaults, bounds, tuple
# position, and strict additional-property behavior remain part of the wire
# contract.
TOOL_INPUT_SCHEMA_SHA256 = {
    "artifact.find": "ac17e7ab19d57565b569c8fac1b0d3cb7558d6707ba134bf4148262b9e7361e2",
    "artifact.submit": "6a0d7b13ad955492a130b31655449efa534ed3cf3316c50053bfa70278da9b2e",
    "candidate.list": "bf7f9192978f1785b0939d890a89c3b562db9125d34cb44f988d990e2bbc509c",
    "candidate.promote": "873ba38c2e42f140ab8eb691f6d2c2fb8cf30ddc22038dba00038b99536ef04c",
    "candidate.stage": "dfdd7ad6a3dd42aac1ac793eaf6ec841f1f7c9b96f1f505743567f888ed90145",
    "candidate.submit": "ee0a52dd32956eca55ce18da531a5db2b35bf59c41f0e589570a9d28c0b9aac1",
    "claim.create": "657e35c9cd860d4eae6e1d6403d77644389ea966471a56470f07b8a995995232",
    "claim.list": "bf7f9192978f1785b0939d890a89c3b562db9125d34cb44f988d990e2bbc509c",
    "claim.update": "55db160bd01130666f1a7a5720f57544e83de4227582249c88d7b265d68eb227",
    "consolidation.get": "63fa52f5081d1395c21ec85a8204d01e96213724b5f226ab7f0adc61edcd0025",
    "consolidation.submit": "3e9b036ca0aa1aa879e0921516b28eb4dbeb2715e8183c854a3c8acc206a5db2",
    "experiment.create": "cf4226fc5da948ceb3e6fa74720ce92e043b07014a99136d044b86b25e0c3fa2",
    "experiment.exhibit": "a70a9ecc2df102418bb86cc5061ab9b930139dab4f6f6def9037230f99c777f3",
    "experiment.get_state": "4abb4d266094018ce686f7d5c8f985eb25a7f5e0b201b201333626a3f560911e",
    "experiment.list": "bf7f9192978f1785b0939d890a89c3b562db9125d34cb44f988d990e2bbc509c",
    "experiment.transition": "69bc10a949b7aef4ba3dfdcf74d64cdb8902cae52f745f73357ca9e55fda8785",
    "feed.list": "83fa2eef2ba251fe37e4ebe81810765c7015b82f17ecc08ea2bd2e1ee4bfc55a",
    "feed.post": "3f354ea7b9596cb06c10667bfe03d9ee83e04d0f491bf57c1218b88e6b5c9f7a",
    "feed.register": "4f09c8eac9262fee9a78b0c59077d6d1970d44e235a35bd4aeaffbda5325c96e",
    "litreview.cite": "41b1e99b098e985e03ff27958c701057f2b7c82b00c11c8990173ff685933896",
    "litreview.edit": "43fdf886b705bdf60d7b7361179eca819fce296fcabb59d85b74ba5cf8587cf5",
    "litreview.view": "092471f2f3c7d5df39cbfb741f6ddf78ef646303aa9cf367c746292c6f3f2312",
    "mlflow.context": "73d3324a8c0dddb1281d3a2c32b7736ee47dea9b9c822816eca979cf23b09a39",
    "mlflow.finalize_run": "6c3723dd4fb2ab9dfeb2a381d35874f2d3c2587ef79bec76db0daa858c9aeffd",
    "project": "ee6b0a43422608b1c6647bd3e6dc7b9316ff4ef4ad9e35716626bfe99ad63b59",
    "project.get": "bf7f9192978f1785b0939d890a89c3b562db9125d34cb44f988d990e2bbc509c",
    "project.list": "99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa",
    "project.update": "b7150f3367aa91185ee1fc988074ef2d0adf76b23a9da2bb207fe6b718dde67d",
    "reflection.create": "c8afd8f54699b4a4196102c217801e2acf254bca1783acb50db108d3bcc1cfca",
    "reflection.get": "08e0d6e280b0de7dd6e6d16621f1c5665ed2fbdc8becbad53ac93429ec840ede",
    "reflection.list": "bf7f9192978f1785b0939d890a89c3b562db9125d34cb44f988d990e2bbc509c",
    "reflection.transition": "2a9b79602febe6aafeeb65eeae51614f28a1fa034c265d850c0e04cd875bf1e8",
    "review.request": "d1b2d4575c51f70414115f8af964675e3e43903ba16604187215e79f563abc9c",
    "review.start": "ee9057b697c95ad6cecf5208ddc8b5ba1022f503106b3f1f5c325e60f058d006",
    "review.status": "aa3d6ff8cbe93e7228d970cbe794f27024ef8f4b80e06705404818fcec05dcda",
    "review.submit": "1cad7232d9f25da6ce479fe4f8a08ba6482c9e35f92130338b855a903776eef2",
    "sandbox.attach": "ee23b4896d74fadcfec8d55f9c4b3c50316099837e0d9a45497c0d533d4e6f43",
    "sandbox.extend": "6b1c3a1ef50ccad6009f750c0bd8db5b9edcd3717c13bb76b4843a2688c2ffff",
    "sandbox.get": "cb58f835a7705c55bd6703cfe9314c9aa002b8f0e6dcffedc384c3fc36c407e9",
    "sandbox.health": "99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa",
    "sandbox.list": "bf7f9192978f1785b0939d890a89c3b562db9125d34cb44f988d990e2bbc509c",
    "sandbox.options": "de93e5483c38e7d2bfa2131611e6f3005f4056f300e5d9cf68f6b89ad714743c",
    "sandbox.pull_outputs": "a8148c40cb5190cb11fc65a92bc6e434a01ca8e0ba05eb0909c2a3343bf20cba",
    "sandbox.release": "785249e6607ce1907def30e2243f73f1100cd4a7d5ed9bc67898018a2ebee38a",
    "sandbox.request": "db07e5678008789301d4fe1c2bd8a8d05e08bcb5d0b176fda3d24421c08f6f8e",
    "sandbox.runs": "72fab984c275b694f03fcde851d06b0e98918aaa13916a65c4c519aecd66cc68",
    "sandbox.terminal": "4140817916c31f3a3694a4197281f8196c6e718971529ae790eadaf639addbf1",
    "storage.complete_upload": "25c9c4e741c2c3c0e284b60213dc18e67eb8751c2fcd0498d4fa60d47d60a879",
    "storage.fetch": "8c6547f9b6845f29addb6c7388fe39eee144a7ff5ce8f17ebd83fa300317bec4",
    "storage.find": "fc53432ef386a65e6392c6d7b20e10028a9bedf9938dd1c7dd2e086063a727bf",
    "storage.object": "3fba20bb5e16ab17aa3e96c203332716c9eb3688332c2e11e573d220046451db",
    "storage.put_object": "550c3f55aa135821f658eba9800d062f4e37b4ad3956af523b105be96d7da15a",
    "storage.submit": "074879ce62d47c893a33b707fb7e307d7bb58c9d3aaccf3da66812f52c7e5fe9",
    "workflow.status_and_next": "73d3324a8c0dddb1281d3a2c32b7736ee47dea9b9c822816eca979cf23b09a39",
}


_UNORDERED_SCHEMA_ARRAYS = frozenset(
    {"allOf", "anyOf", "enum", "examples", "oneOf", "required"}
)


def _normalized_schema(value, *, parent_key: str = ""):
    if isinstance(value, dict):
        return {
            key: _normalized_schema(item, parent_key=key)
            for key, item in sorted(value.items())
            if key not in {"title", "description"}
        }
    if isinstance(value, list):
        items = [_normalized_schema(item, parent_key=parent_key) for item in value]
        if parent_key in _UNORDERED_SCHEMA_ARRAYS:
            return sorted(
                items,
                key=lambda item: json.dumps(
                    item, sort_keys=True, separators=(",", ":")
                ),
            )
        return items
    return value


class ToolContractRegistryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.env_patch = patch.dict(os.environ, {STORAGE_PROVIDER_ENV_VAR: ""})
        self.env_patch.start()
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            execution_backend=FakeSandboxBackend(),
        )

    def tearDown(self) -> None:
        self.app.shutdown()
        self.env_patch.stop()
        self.tmp.cleanup()

    def test_registered_tools_match_contracts_and_have_descriptions(self) -> None:
        tools = {tool["name"]: tool for tool in self.app.list_tools()}

        self.assertEqual(set(tools), available_tool_names(storage_enabled=False))
        self.assertFalse(set(tools) & STORAGE_TOOL_NAMES)
        for name, contract in TOOL_CONTRACTS.items():
            if name not in tools:
                continue
            self.assertTrue(contract.description.strip(), name)
            self.assertEqual(tools[name]["description"], contract.description)

    def test_tool_profiles_are_a_frozen_external_inventory(self) -> None:
        profiles = (
            (
                False,
                False,
                BASE_PUBLIC_TOOLS,
                BASE_INTERNAL_TOOLS,
            ),
            (
                True,
                False,
                BASE_PUBLIC_TOOLS | STORAGE_PUBLIC_TOOLS,
                BASE_INTERNAL_TOOLS | STORAGE_INTERNAL_TOOLS,
            ),
            (
                False,
                True,
                BASE_PUBLIC_TOOLS | TRACKING_PUBLIC_TOOLS,
                BASE_INTERNAL_TOOLS,
            ),
            (
                True,
                True,
                BASE_PUBLIC_TOOLS | STORAGE_PUBLIC_TOOLS | TRACKING_PUBLIC_TOOLS,
                BASE_INTERNAL_TOOLS | STORAGE_INTERNAL_TOOLS,
            ),
        )
        for storage_enabled, tracking_enabled, public, internal in profiles:
            with self.subTest(
                storage_enabled=storage_enabled,
                tracking_enabled=tracking_enabled,
            ):
                available = available_tool_names(
                    storage_enabled=storage_enabled,
                    tracking_enabled=tracking_enabled,
                )
                self.assertEqual(
                    {
                        name
                        for name in available
                        if TOOL_MANIFEST[name].visibility == "public"
                    },
                    public,
                )
                self.assertEqual(available - public, internal)

    def test_tool_scope_and_feature_groups_are_frozen(self) -> None:
        by_scope = {
            scope: {
                name
                for name, tool in TOOL_MANIFEST.items()
                if tool.scope_strategy == scope
            }
            for scope in ("caller-selected", "capability", "none", "linked-project")
        }
        self.assertEqual(by_scope["caller-selected"], {"project"})
        self.assertEqual(by_scope["capability"], {"review.start", "review.submit"})
        self.assertEqual(by_scope["none"], {"project.list", "sandbox.health"})
        self.assertEqual(
            by_scope["linked-project"],
            set(TOOL_MANIFEST)
            - by_scope["caller-selected"]
            - by_scope["capability"]
            - by_scope["none"],
        )
        self.assertEqual(
            {name for name, tool in TOOL_MANIFEST.items() if tool.feature_requirements},
            STORAGE_PUBLIC_TOOLS | STORAGE_INTERNAL_TOOLS,
        )

    def test_tool_input_schemas_match_the_frozen_semantic_fingerprints(self) -> None:
        actual = {}
        for name, tool in TOOL_MANIFEST.items():
            normalized = _normalized_schema(tool.input_model.model_json_schema())
            encoded = json.dumps(
                normalized, sort_keys=True, separators=(",", ":")
            ).encode()
            actual[name] = hashlib.sha256(encoded).hexdigest()
        self.assertEqual(actual, TOOL_INPUT_SCHEMA_SHA256)

    def test_live_app_serves_every_available_manifest_tool(self) -> None:
        dispatched = set(self.app._app.tools._tools)
        available = available_tool_names(storage_enabled=False)
        self.assertEqual(dispatched, available)

    def test_served_schemas_avoid_provider_rejected_constructs(self) -> None:
        def nodes(value):
            if isinstance(value, dict):
                yield value
                for child in value.values():
                    yield from nodes(child)
            elif isinstance(value, list):
                for child in value:
                    yield from nodes(child)

        for tool in self.app.list_tools():
            for node in nodes(tool["inputSchema"]):
                self.assertNotIn("const", node, tool["name"])
                if "enum" in node:
                    self.assertNotIn("", node["enum"], tool["name"])

    def test_manifest_owns_all_routing_and_handler_metadata(self) -> None:
        self.assertIs(TOOL_CONTRACTS, TOOL_MANIFEST)
        for name, tool in TOOL_MANIFEST.items():
            self.assertIn(tool.visibility, {"public", "internal"}, name)
            self.assertIn(
                tool.scope_strategy,
                {"linked-project", "caller-selected", "capability", "none"},
                name,
            )
            self.assertTrue(tool.handler_identity, name)
            self.assertLessEqual(set(tool.feature_requirements), {"storage"}, name)

    def test_hidden_tools_stay_in_catalog_with_hidden_flag(self) -> None:
        # Internal tools remain dispatchable for trusted in-process callers,
        # while the HTTP MCP catalog hides them from agents.
        self.assertLessEqual(MCP_HIDDEN_TOOL_NAMES, set(TOOL_CONTRACTS))
        self.assertIn("project.get", MCP_HIDDEN_TOOL_NAMES)
        self.assertIn("project.update", MCP_HIDDEN_TOOL_NAMES)
        # review.status is served for REST/UI reads and internal dispatch, but
        # agents poll workflow.status_and_next (its review_gate re-reports state).
        self.assertIn("review.status", MCP_HIDDEN_TOOL_NAMES)
        # Experiment orientation is consolidated in workflow.status_and_next;
        # the old state reader remains internal for REST/UI compatibility.
        self.assertIn("experiment.get_state", MCP_HIDDEN_TOOL_NAMES)
        # The exhibit preview is intentionally unchanged and remains public.
        self.assertNotIn("experiment.exhibit", MCP_HIDDEN_TOOL_NAMES)
        # Enumeration readers embedded in other responses stay REST/UI-only.
        # sandbox.list is NO LONGER hidden: a project-scoped mk_ key needs it to
        # enumerate the project's (shared) sandboxes over MCP (no-dataplane
        # Phase C).
        for reader in (
            "claim.list",
            "experiment.list",
            "reflection.list",
            "sandbox.health",
        ):
            self.assertIn(reader, MCP_HIDDEN_TOOL_NAMES, reader)
        self.assertNotIn("sandbox.list", MCP_HIDDEN_TOOL_NAMES)
        for name in MCP_HIDDEN_TOOL_NAMES:
            self.assertEqual(TOOL_CONTRACTS[name].visibility, "internal", name)
        for name, tool in TOOL_CONTRACTS.items():
            if name not in MCP_HIDDEN_TOOL_NAMES:
                self.assertEqual(tool.visibility, "public", name)

    def test_sandbox_tool_descriptions_carry_lifecycle_guidance(self) -> None:
        tools = {tool["name"]: tool for tool in self.app.list_tools()}
        self.assertNotIn("MLflow", tools["sandbox.request"]["description"])
        self.assertNotIn("TensorBoard", tools["sandbox.request"]["description"])
        self.assertIn("brain-composed hint", tools["sandbox.request"]["description"])
        self.assertIn("durable storage", tools["sandbox.request"]["description"])
        self.assertIn("public_key", tools["sandbox.request"]["description"])
        self.assertIn("public_key_source", tools["sandbox.request"]["description"])
        self.assertIn("expiry", tools["sandbox.get"]["description"])
        self.assertIn("poll provisioning", tools["sandbox.get"]["description"])
        self.assertIn("brain-composed hint", tools["sandbox.get"]["description"])
        self.assertIn("public_key_source", tools["sandbox.get"]["description"])
        self.assertIn("confirm_retained", tools["sandbox.release"]["description"])
        self.assertIn("retention checklist", tools["sandbox.release"]["description"])
        self.assertIn("metrics snapshot", tools["sandbox.release"]["description"])
        self.assertIn("calling agent", tools["sandbox.pull_outputs"]["description"])
        self.assertIn("object storage", tools["sandbox.pull_outputs"]["description"])
        self.assertIn("sandbox.release", tools["sandbox.pull_outputs"]["description"])

    def test_storage_tools_registered_with_expected_input_models(self) -> None:
        expected = {
            "storage.put_object": StoragePutObjectInput,
            "storage.submit": StorageSubmitInput,
            "storage.complete_upload": StorageCompleteUploadInput,
            "storage.fetch": StorageFetchInput,
            "storage.find": StorageFindInput,
            "storage.object": StorageObjectInput,
        }
        self.assertEqual(
            STORAGE_TOOL_NAMES,
            set(expected),
            "storage surface must be exactly these 6 tools",
        )
        for name, model in expected.items():
            self.assertIs(TOOL_CONTRACTS[name].input_model, model)
        self.assertIn(
            "checkpoints/models", TOOL_CONTRACTS["storage.put_object"].description
        )
        self.assertIn(
            "logs/traces over about 10 MB", TOOL_CONTRACTS["storage.submit"].description
        )

    def test_storage_find_enforces_resolve_vs_list_mode(self) -> None:
        # List mode: neither selector.
        StorageFindInput.model_validate({"project_id": "p", "kind": "model"})
        # Resolve mode: exactly one selector.
        StorageFindInput.model_validate({"project_id": "p", "object_id": "so_1"})
        StorageFindInput.model_validate({"project_id": "p", "name": "datasets/x"})
        # Both selectors is ambiguous.
        with self.assertRaises(PydanticValidationError):
            StorageFindInput.model_validate(
                {"project_id": "p", "object_id": "so_1", "name": "datasets/x"}
            )
        # version without a resolve target is meaningless.
        with self.assertRaises(PydanticValidationError):
            StorageFindInput.model_validate({"project_id": "p", "version": 2})

    def test_storage_completion_normalizes_legacy_provider_part_names(self) -> None:
        validated = StorageCompleteUploadInput.model_validate(
            {
                "project_id": "p",
                "upload_id": "upload_1",
                "parts": [{"PartNumber": 1, "ETag": '"abc"'}],
            }
        )
        self.assertEqual(validated.parts, [{"part_number": 1, "etag": '"abc"'}])

    def test_storage_object_action_is_required_and_enumerated(self) -> None:
        StorageObjectInput.model_validate(
            {"project_id": "p", "object_id": "so_1", "action": "pin"}
        )
        with self.assertRaises(PydanticValidationError):
            StorageObjectInput.model_validate({"project_id": "p", "object_id": "so_1"})
        with self.assertRaises(PydanticValidationError):
            StorageObjectInput.model_validate(
                {"project_id": "p", "object_id": "so_1", "action": "purge"}
            )

    def test_artifact_tools_are_manifested(self) -> None:
        self.assertIs(
            TOOL_CONTRACTS["artifact.submit"].input_model, ArtifactSubmitInput
        )
        self.assertIs(TOOL_CONTRACTS["artifact.find"].input_model, ArtifactFindInput)
        # The whole resource-tracking tool family died with the resource cut.
        for removed in ("resource.register", "resource.find", "resource.delete"):
            self.assertNotIn(removed, TOOL_CONTRACTS)

    def test_artifact_submit_requires_lens_id_only_for_lens_docs(self) -> None:
        base = {
            "project_id": "p",
            "target_type": "reflection",
            "target_id": "syn_1",
            "path": "reflections/amplify.md",
        }
        with self.assertRaises(PydanticValidationError):
            ArtifactSubmitInput.model_validate({**base, "role": "reflection_lens_doc"})
        with self.assertRaises(PydanticValidationError):
            ArtifactSubmitInput.model_validate(
                {**base, "role": "reflection_doc", "lens_id": "amplify"}
            )
        parsed = ArtifactSubmitInput.model_validate(
            {**base, "role": "reflection_lens_doc", "lens_id": "amplify"}
        )
        self.assertEqual(parsed.lens_id, "amplify")

    def test_reflection_get_defaults_to_summaries_with_explicit_full_opt_in(
        self,
    ) -> None:
        default = ReflectionGetInput.model_validate(
            {"project_id": "proj_1", "reflection_id": "syn_1"}
        )
        deep_dive = ReflectionGetInput.model_validate(
            {
                "project_id": "proj_1",
                "reflection_id": "syn_1",
                "include_content": True,
            }
        )

        self.assertFalse(default.include_content)
        self.assertTrue(deep_dive.include_content)
        description = TOOL_CONTRACTS["reflection.get"].description
        self.assertIn("TLDRs", description)
        self.assertIn("include_content=true", description)

    def test_sandbox_pull_outputs_contract(self) -> None:
        self.assertIs(
            TOOL_CONTRACTS["sandbox.pull_outputs"].input_model,
            SandboxPullOutputsInput,
        )
        schema = SandboxPullOutputsInput.model_json_schema()
        self.assertNotIn("key_path", schema["properties"])
        self.assertNotIn("destination_path", schema["properties"])
        self.assertNotIn("overwrite", schema["properties"])

    def test_sandbox_request_accepts_caller_public_key(self) -> None:
        parsed = SandboxRequestInput.model_validate(
            {
                "project_id": "proj_1",
                "public_key": "ssh-ed25519 " + ("A" * 48) + " caller@test",
            }
        )

        self.assertTrue(parsed.public_key.startswith("ssh-ed25519 "))

    def test_sandbox_request_rejects_private_or_multiline_key_material(self) -> None:
        for public_key in (
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "ssh-ed25519 " + ("A" * 48) + "\ncomment",
            "not-a-key " + ("A" * 48),
        ):
            with self.subTest(public_key=public_key):
                with self.assertRaises(PydanticValidationError):
                    SandboxRequestInput.model_validate(
                        {"project_id": "proj_1", "public_key": public_key}
                    )

    def test_sandbox_extend_contract(self) -> None:
        self.assertIs(
            TOOL_CONTRACTS["sandbox.extend"].input_model,
            SandboxExtendInput,
        )

    def test_experiment_materialize_folders_is_deleted(self) -> None:
        # D6: folder layout is now a skill instruction, not a tool.
        self.assertNotIn("experiment.materialize_folders", TOOL_CONTRACTS)

    def test_review_request_and_start_is_removed(self) -> None:
        # Removed: it started the reviewer session server-side, letting the
        # producer submit against its own gate. review.request's spawn-ready
        # handoff is the sanctioned one-call path.
        self.assertNotIn("review.request_and_start", TOOL_CONTRACTS)

    def test_mlflow_finalize_run_contract(self) -> None:
        self.assertIs(
            TOOL_CONTRACTS["mlflow.finalize_run"].input_model,
            MlflowFinalizeRunInput,
        )


class ToolDispatcherTest(unittest.TestCase):
    def test_dispatcher_can_expose_the_manifest(self) -> None:
        tool_names = set(TOOL_MANIFEST)
        handlers = {name: (lambda **_: {}) for name in tool_names}
        dispatcher = ToolDispatcher(
            handlers=handlers,
            activity=object(),
            tool_calls=object(),
            tool_names=tool_names,
        )

        listed_names = {tool["name"] for tool in dispatcher.list_tools()}
        self.assertEqual(listed_names, tool_names)

    def test_reviewer_session_cannot_mutate_through_another_tool(self) -> None:
        dispatcher = ToolDispatcher(
            handlers={"claim.create": lambda **_: {}},
            activity=Mock(),
            tool_calls=Mock(),
            tool_names={"claim.create"},
        )

        with self.assertRaisesRegex(PermissionDeniedError, "read-only"):
            dispatcher.call_tool(
                "claim.create",
                {"project_id": "proj_1", "review_session_id": "rvs_1"},
            )


if __name__ == "__main__":
    unittest.main()
