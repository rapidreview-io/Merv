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
from merv.brain.kernel.utils import PermissionDeniedError, ResearchPluginError
from merv.brain.infrastructure.tools import (
    SandboxExtendInput,
    SandboxPullOutputsInput,
    SandboxRequestInput,
    StorageCompleteUploadInput,
    StorageFetchInput,
    StorageFindInput,
    StorageObjectInput,
    StoragePutObjectInput,
    StorageSubmitInput,
)
from merv.brain.research_core import ENTITY_REF_VOCABULARY, FEED_AUTHOR_ROLES
from merv.brain.research_core.tools import ReflectionGetInput
from merv.brain.surface.tools.contracts import (
    STORAGE_TOOL_NAMES,
    TOOL_MANIFEST,
    available_tool_names,
)
from merv.brain.workflows import ARTIFACT_TARGET_TYPES, SUBMITTABLE_ROLES
from tests.support.infrastructure import FakeInfrastructureClient
from merv.brain.surface.tools.dispatcher import ToolDispatcher

# Artifacts renders the association vocabulary the composition injects, so the
# models exist only inside the built table.
HIDDEN_TOOL_NAMES = frozenset(
    name for name, tool in TOOL_MANIFEST.items() if tool.visibility == "internal"
)
ArtifactReadInput = TOOL_MANIFEST["artifact.read"].input_model
ArtifactUploadInput = TOOL_MANIFEST["artifact.upload"].input_model


BASE_PUBLIC_TOOLS = frozenset(
    {
        "agent.hello",
        "artifact.upload",
        "artifact.read",
        "artifact.attach",
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
        "project.context.update",
        "project.synthesis.read",
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
        "sandbox.run",
        "sandbox.job",
        "sandbox.runs",
        "sandbox.terminal",
        "task.create",
        "task.transition",
        "workflow.status_and_next",
        "workflow.catalog",
        "workflow.start",
        "workflow.transition",
        "workflow.assignment",
        "workflow.begin",
        "workflow.history",
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
        "task.get_state",
        "task.list",
    }
)
STORAGE_PUBLIC_TOOLS = frozenset(
    {"storage.fetch", "storage.find", "storage.object", "storage.submit"}
)
STORAGE_INTERNAL_TOOLS = frozenset({"storage.complete_upload", "storage.put_object"})

# Normalized Pydantic schemas: prose and non-semantic ordering are deliberately
# excluded, while fields, requiredness, unions, enums, defaults, bounds, tuple
# position, and strict additional-property behavior remain part of the wire
# contract.
TOOL_INPUT_SCHEMA_SHA256 = {
    "project.synthesis.read": "7cc45e51178ed3547e389156185e8f329fd7b92e0a8559e3358d953be345fc2d",
    "project.context.update": "146f0a868e2730e6dd9850e41e6cbab9a2980cb39d86af779516f9f8466669f4",
    "workflow.begin": "7e1f66e8766a011eae57680548d7d9cb2761ac24f8445d6d2c0866b4b4a05e39",
    "workflow.history": "5eb500efff24fefe5e4ea72ecf5eaf0dda5eaf04da3edf73000e65f064d4671a",
    "workflow.assignment": "5eb500efff24fefe5e4ea72ecf5eaf0dda5eaf04da3edf73000e65f064d4671a",
    "workflow.transition": "2ae86744e916c03c59a0c09351ddd32b87ed3183a2ca3e53c3323dbed870d229",
    "workflow.start": "1c9075387e05da362f6380d2c1f854f268038b86a31158a81221365803829091",
    "workflow.catalog": "99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa",
    "agent.hello": "cb3195328ef9d7ec6b078452696b790e81e25d84b559f0cb97a08668213aec3c",
    "artifact.read": "ac17e7ab19d57565b569c8fac1b0d3cb7558d6707ba134bf4148262b9e7361e2",
    "artifact.attach": "72ae3c651f7499b1cbc4b7875e794635f365b0e29fc94539b89393f4a15535ba",
    "artifact.upload": "5f0cbec4078a87d27198755779be2989ba76408395fee7c4099b22a589835c97",
    "candidate.list": "bf7f9192978f1785b0939d890a89c3b562db9125d34cb44f988d990e2bbc509c",
    "candidate.promote": "873ba38c2e42f140ab8eb691f6d2c2fb8cf30ddc22038dba00038b99536ef04c",
    "candidate.stage": "dfdd7ad6a3dd42aac1ac793eaf6ec841f1f7c9b96f1f505743567f888ed90145",
    "candidate.submit": "ee0a52dd32956eca55ce18da531a5db2b35bf59c41f0e589570a9d28c0b9aac1",
    "claim.create": "657e35c9cd860d4eae6e1d6403d77644389ea966471a56470f07b8a995995232",
    "claim.list": "bf7f9192978f1785b0939d890a89c3b562db9125d34cb44f988d990e2bbc509c",
    "claim.update": "55db160bd01130666f1a7a5720f57544e83de4227582249c88d7b265d68eb227",
    "consolidation.get": "63fa52f5081d1395c21ec85a8204d01e96213724b5f226ab7f0adc61edcd0025",
    "consolidation.submit": "47d8d676b8d6c69af8e2ec9c803678f50de826c5e7e5e9449f5f16596370ea37",
    "experiment.create": "bc3607c0787f319819e3e4c98ec214eb245d7feb636f3025d146069267514fc3",
    "experiment.exhibit": "a70a9ecc2df102418bb86cc5061ab9b930139dab4f6f6def9037230f99c777f3",
    "experiment.get_state": "4abb4d266094018ce686f7d5c8f985eb25a7f5e0b201b201333626a3f560911e",
    "experiment.list": "bf7f9192978f1785b0939d890a89c3b562db9125d34cb44f988d990e2bbc509c",
    "experiment.transition": "5853df9367eb8545ab3aabb593f81b1430ea3551f8ef9e9b7389d5218cee9c9d",
    "feed.list": "83fa2eef2ba251fe37e4ebe81810765c7015b82f17ecc08ea2bd2e1ee4bfc55a",
    "feed.post": "4ae8d1aa5565a69ffabdb443bc760a8981b9eb022757c41d0ab58d6a35eda850",
    "feed.register": "664d9d0e70bbb1ac315788acae97e73febf07be2b803fe533f82fecefc7ea326",
    "litreview.cite": "41b1e99b098e985e03ff27958c701057f2b7c82b00c11c8990173ff685933896",
    "litreview.edit": "43fdf886b705bdf60d7b7361179eca819fce296fcabb59d85b74ba5cf8587cf5",
    "litreview.view": "092471f2f3c7d5df39cbfb741f6ddf78ef646303aa9cf367c746292c6f3f2312",
    "project": "b786270c921a4e4beb9c861cc7294a54441e45d40de4af4df89530b475359495",
    "project.get": "bf7f9192978f1785b0939d890a89c3b562db9125d34cb44f988d990e2bbc509c",
    "project.list": "99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa",
    "project.update": "55818f8adb3b5d75b86ff5b7321423928234b1729eb44134850531e2e8d5d929",
    "reflection.create": "e104fade0b899c50155055c2157f065241888a6d80eeddbae8a7d71143bdad5b",
    "reflection.get": "08e0d6e280b0de7dd6e6d16621f1c5665ed2fbdc8becbad53ac93429ec840ede",
    "reflection.list": "bf7f9192978f1785b0939d890a89c3b562db9125d34cb44f988d990e2bbc509c",
    "reflection.transition": "6c2a85a45ea54f5c28d9e1f24444f513cf412cade679419fceff6b0b3d699643",
    "review.request": "485c8eb3a9228e08a4cd74ac89044a95d221014625d984cf2ad20825a626baaa",
    "review.start": "ee9057b697c95ad6cecf5208ddc8b5ba1022f503106b3f1f5c325e60f058d006",
    "review.status": "f77236c493e0a6d6c270c2d6beee060596bbf8b7c51b587b74887e9c29830a95",
    "review.submit": "6545cf3024c46ffb5bb26517093a4a5b50b2c8b84e900f8cfd22c26427aeb208",
    "sandbox.attach": "ee23b4896d74fadcfec8d55f9c4b3c50316099837e0d9a45497c0d533d4e6f43",
    "sandbox.extend": "6b1c3a1ef50ccad6009f750c0bd8db5b9edcd3717c13bb76b4843a2688c2ffff",
    "sandbox.get": "cb58f835a7705c55bd6703cfe9314c9aa002b8f0e6dcffedc384c3fc36c407e9",
    "sandbox.health": "99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa",
    "sandbox.list": "bf7f9192978f1785b0939d890a89c3b562db9125d34cb44f988d990e2bbc509c",
    "sandbox.options": "de93e5483c38e7d2bfa2131611e6f3005f4056f300e5d9cf68f6b89ad714743c",
    "sandbox.pull_outputs": "a8148c40cb5190cb11fc65a92bc6e434a01ca8e0ba05eb0909c2a3343bf20cba",
    "sandbox.release": "785249e6607ce1907def30e2243f73f1100cd4a7d5ed9bc67898018a2ebee38a",
    "sandbox.request": "55578273540e8aff3fd503bbf69ccd3808c9aa4015c78284ad0f0c139c14be90",
    "sandbox.run": "9eb58636ba23129f5d865e29b9fcd063da86af8bff24ce210634ec557123fc53",
    "sandbox.job": "06cc8ac6ea0666bcb3f9a7238898758b985f4ccc6e346286917753d1c3982c57",
    "sandbox.runs": "77ffc5d671133be302ac63343bd68533c0aaef124e94b98b25f3ad8a85a964d3",
    "sandbox.terminal": "2cfd80ededc678a7fa4c537b3d80a70445342c06a45f079c3bf9ba2c6c934018",
    "storage.complete_upload": "25c9c4e741c2c3c0e284b60213dc18e67eb8751c2fcd0498d4fa60d47d60a879",
    "storage.fetch": "8c6547f9b6845f29addb6c7388fe39eee144a7ff5ce8f17ebd83fa300317bec4",
    "storage.find": "47228bc70ae51084bbbaad6ad31b86f839db7d26fd483e0791d74ec30ce3e672",
    "storage.object": "0a480a5fb382d8667a5146cbe11c5f1155158ef1b6460e1dc0bb173c93d8820b",
    "storage.put_object": "550c3f55aa135821f658eba9800d062f4e37b4ad3956af523b105be96d7da15a",
    "storage.submit": "074879ce62d47c893a33b707fb7e307d7bb58c9d3aaccf3da66812f52c7e5fe9",
    "task.create": "b7491b256aea7e16230389fff86175c025aeed06db094b688dd6e94bcc7dfa87",
    "task.get_state": "523a5b27c7e96a0548c42aea81d3e841919cbaa7f3d4af34fce688397c656867",
    "task.list": "bf7f9192978f1785b0939d890a89c3b562db9125d34cb44f988d990e2bbc509c",
    "task.transition": "7cc5a9a22300c576ab564ad43412d1940b6d1795f126d52ac4e324c072ee5a68",
    "workflow.status_and_next": "abdafec8ffdee1ceaba417158b7084f227d0ff508eb3e84384a531d7c4dce537",
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
        self.env_patch = patch.dict(os.environ, {"MERV_SANDBOXES_URL": ""})
        self.env_patch.start()
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            infrastructure_client=FakeInfrastructureClient(),
        )

    def tearDown(self) -> None:
        self.app.shutdown()
        self.env_patch.stop()
        self.tmp.cleanup()

    def test_registered_tools_match_contracts_and_have_descriptions(self) -> None:
        tools = {tool["name"]: tool for tool in self.app.list_tools()}

        self.assertEqual(set(tools), available_tool_names(storage_enabled=False))
        self.assertFalse(set(tools) & STORAGE_TOOL_NAMES)
        for name, contract in TOOL_MANIFEST.items():
            if name not in tools:
                continue
            self.assertTrue(contract.description.strip(), name)
            self.assertEqual(tools[name]["description"], contract.description)

    def test_tool_profiles_are_a_frozen_external_inventory(self) -> None:
        profiles = (
            (False, BASE_PUBLIC_TOOLS, BASE_INTERNAL_TOOLS),
            (
                True,
                BASE_PUBLIC_TOOLS | STORAGE_PUBLIC_TOOLS,
                BASE_INTERNAL_TOOLS | STORAGE_INTERNAL_TOOLS,
            ),
        )
        for storage_enabled, public, internal in profiles:
            with self.subTest(storage_enabled=storage_enabled):
                available = available_tool_names(storage_enabled=storage_enabled)
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
        self.assertEqual(
            by_scope["none"], {"agent.hello", "project.list", "sandbox.health", "workflow.catalog"}
        )
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
        self.assertLessEqual(HIDDEN_TOOL_NAMES, set(TOOL_MANIFEST))
        self.assertIn("project.get", HIDDEN_TOOL_NAMES)
        self.assertIn("project.update", HIDDEN_TOOL_NAMES)
        # review.status is served for REST/UI reads and internal dispatch, but
        # agents poll workflow.status_and_next (its review_gate re-reports state).
        self.assertIn("review.status", HIDDEN_TOOL_NAMES)
        # Experiment orientation is consolidated in workflow.status_and_next;
        # the old state reader remains internal for REST/UI compatibility.
        self.assertIn("experiment.get_state", HIDDEN_TOOL_NAMES)
        # The exhibit preview is intentionally unchanged and remains public.
        self.assertNotIn("experiment.exhibit", HIDDEN_TOOL_NAMES)
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
            self.assertIn(reader, HIDDEN_TOOL_NAMES, reader)
        self.assertNotIn("sandbox.list", HIDDEN_TOOL_NAMES)
        for name in HIDDEN_TOOL_NAMES:
            self.assertEqual(TOOL_MANIFEST[name].visibility, "internal", name)
        for name, tool in TOOL_MANIFEST.items():
            if name not in HIDDEN_TOOL_NAMES:
                self.assertEqual(tool.visibility, "public", name)

    def test_sandbox_tool_descriptions_carry_lifecycle_guidance(self) -> None:
        tools = {tool["name"]: tool for tool in self.app.list_tools()}
        for name, guidance in {
            "sandbox.request": ("sandbox.options", "provider", "certificate"),
            "sandbox.get": ("poll", "certificate", "gateway host key"),
            "sandbox.release": ("confirm_retained", "cleanup_pending", "bill"),
            "sandbox.pull_outputs": ("rsync", "caller machine", "retaining"),
            "sandbox.run": ("durable", "job_id", "sandbox.job"),
            "sandbox.job": ("retained", "wait_seconds", "tail"),
        }.items():
            for word in guidance:
                self.assertIn(word, tools[name]["description"])

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
            self.assertIs(TOOL_MANIFEST[name].input_model, model)
        self.assertIn(
            "checkpoints/models", TOOL_MANIFEST["storage.put_object"].description
        )
        self.assertIn(
            "logs/traces over about 10 MB", TOOL_MANIFEST["storage.submit"].description
        )

    def test_storage_find_enforces_resolve_vs_list_mode(self) -> None:
        # List mode: neither selector; the service state filter is the only one.
        StorageFindInput.model_validate({"project_id": "p", "status": "available"})
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
        self.assertEqual(
            {name for name in TOOL_MANIFEST if name.startswith("artifact.")},
            {"artifact.upload", "artifact.read", "artifact.attach"},
        )
        association = TOOL_MANIFEST["artifact.attach"].input_model.model_json_schema()
        self.assertEqual(
            association["properties"]["target_type"]["enum"],
            sorted(ARTIFACT_TARGET_TYPES),
        )
        self.assertEqual(
            association["properties"]["role"]["enum"], sorted(SUBMITTABLE_ROLES)
        )
        # The whole resource-tracking tool family died with the resource cut.
        for removed in ("resource.register", "resource.find", "resource.delete"):
            self.assertNotIn(removed, TOOL_MANIFEST)

    def test_feed_schema_renders_the_injected_vocabulary(self) -> None:
        # The feed owns its contracts but not the ids or roles in them: the
        # composition hands it the same vocabulary FeedService receives.
        role = TOOL_MANIFEST["feed.register"].input_model.model_fields["role"]
        self.assertEqual(sorted(role.annotation.__args__), sorted(FEED_AUTHOR_ROLES))
        ref = TOOL_MANIFEST["feed.post"].input_model.model_fields["ref"].description
        for prefix, _ in ENTITY_REF_VOCABULARY:
            self.assertIn(prefix, ref)

    def test_removed_artifact_names_are_unknown(self) -> None:
        for name in ("artifact.store", "artifact.submit", "artifact.find"):
            with self.subTest(tool=name):
                self.assertNotIn(name, TOOL_MANIFEST)
                with self.assertRaisesRegex(ResearchPluginError, "unknown tool:"):
                    self.app.call_tool(name, {"project_id": "p"})

    def test_artifact_upload_requires_lens_id_only_for_lens_docs(self) -> None:
        base = {"project_id": "p", "path": "reflections/amplify.md"}
        target = {"target_type": "reflection", "target_id": "syn_1"}
        with self.assertRaises(PydanticValidationError):
            ArtifactUploadInput.model_validate({
                **base, "attach_to": {**target, "role": "reflection_lens_doc"},
            })
        with self.assertRaises(PydanticValidationError):
            ArtifactUploadInput.model_validate({
                **base, "attach_to": {**target, "role": "reflection_doc", "lens_id": "amplify"},
            })
        parsed = ArtifactUploadInput.model_validate({
            **base, "attach_to": {**target, "role": "reflection_lens_doc", "lens_id": "amplify"},
        })
        self.assertEqual(parsed.attach_to.lens_id, "amplify")

    def test_artifact_upload_accepts_unattached_content_and_rejects_partial_targets(self) -> None:
        base = {"project_id": "p", "path": "arbitrary.bin"}
        self.assertIsNone(ArtifactUploadInput.model_validate(base).attach_to)
        for attach_to in ({}, {"target_type": "experiment", "role": "plan"}, "exp_1"):
            with self.subTest(attach_to=attach_to), self.assertRaises(PydanticValidationError):
                ArtifactUploadInput.model_validate({**base, "attach_to": attach_to})
        with self.assertRaises(PydanticValidationError):
            ArtifactUploadInput.model_validate({**base, "target_type": "experiment", "role": "plan"})

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
        description = TOOL_MANIFEST["reflection.get"].description
        self.assertIn("TLDRs", description)
        self.assertIn("include_content=true", description)

    def test_sandbox_pull_outputs_contract(self) -> None:
        self.assertIs(
            TOOL_MANIFEST["sandbox.pull_outputs"].input_model,
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
            TOOL_MANIFEST["sandbox.extend"].input_model,
            SandboxExtendInput,
        )

    def test_experiment_materialize_folders_is_deleted(self) -> None:
        # D6: folder layout is now a skill instruction, not a tool.
        self.assertNotIn("experiment.materialize_folders", TOOL_MANIFEST)

    def test_review_request_and_start_is_removed(self) -> None:
        # Removed: it started the reviewer session server-side, letting the
        # producer submit against its own gate. review.request's spawn-ready
        # handoff is the sanctioned one-call path.
        self.assertNotIn("review.request_and_start", TOOL_MANIFEST)


class ToolDispatcherTest(unittest.TestCase):
    def test_dispatcher_can_expose_the_manifest(self) -> None:
        tool_names = set(TOOL_MANIFEST)
        handlers = {name: (lambda **_: {}) for name in tool_names}
        dispatcher = ToolDispatcher(
            handlers=handlers,
            activity=object(),
            tool_names=tool_names,
        )

        listed_names = {tool["name"] for tool in dispatcher.list_tools()}
        self.assertEqual(listed_names, tool_names)

    def test_reviewer_session_cannot_mutate_through_another_tool(self) -> None:
        dispatcher = ToolDispatcher(
            handlers={"claim.create": lambda **_: {}},
            activity=Mock(),
            tool_names={"claim.create"},
        )

        with self.assertRaisesRegex(PermissionDeniedError, "read-only"):
            dispatcher.call_tool(
                "claim.create",
                {"project_id": "proj_1", "review_session_id": "rvs_1"},
            )


if __name__ == "__main__":
    unittest.main()
