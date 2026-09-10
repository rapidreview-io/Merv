"""End-to-end artifact submit flow: tool -> token PUT -> gates/reads."""

from __future__ import annotations

import hashlib
import json
import shlex
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tests.support.brain import TestBrain
from merv.brain.research_core import ArtifactTarget
from merv.brain.kernel.utils import NotFoundError, ValidationError
from merv.brain.surface.transport.api.gateway import RequestAuthenticator
from merv.brain.surface.transport.api.artifacts import build_router
from merv.brain.surface.transport.http_policy import HttpSurfacePolicy

VALID_PLAN = (
    "## Summary\nA toy experiment used by the artifact-flow tests.\n\n"
    "## Objective & hypothesis\nThreshold beats the majority baseline.\n\n"
    "## Evaluation\nAccuracy vs baseline; success if accuracy > 0.6.\n"
)

VALID_REPORT = (
    "## Summary\nRan the toy experiment per the approved plan.\n\n"
    "## Results\nPer metrics_exhibit.json, accuracy 0.72 vs target 0.60.\n\n"
    "## Deviations from plan\nNone.\n\n"
    "## Conclusion\nDecision rule met.\n"
)

VALID_GRAPH = (
    '{"version": 1, "nodes": ['
    '{"id": "obj", "kind": "objective", "label": "Beat baseline"},'
    '{"id": "out", "kind": "outcome", "label": "Met at 0.72"}],'
    ' "edges": [{"from": "obj", "to": "out", "label": "confirmed by"}]}\n'
)


def full_roster() -> list[dict[str, str]]:
    return [
        {"id": "amplify"},
        {"id": "avoid"},
        {"id": "entropy"},
        {
            "id": "rigor",
            "charter": "Methodological soundness of the experiments.",
            "why_distinct": "Judges how we measured, not what we found.",
        },
        {
            "id": "cost",
            "charter": "Compute spent vs information gained per experiment.",
            "why_distinct": "Prices the exploration; no core lens does.",
        },
    ]


class ArtifactFlowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
        )
        self.project_id = self.call("project", action="create", name="Artifact Flow")["id"]

    def tearDown(self) -> None:
        self.tmp.cleanup()
        self.app.shutdown()

    def call(self, tool_name: str, **kwargs):
        return self.app.call_tool(tool_name, kwargs)

    def _submit(
        self,
        *,
        target_type: str,
        target_id: str,
        role: str,
        path: str,
        body: str,
        lens_id: str = "",
    ) -> dict:
        pending = self.call(
            "artifact.upload",
            project_id=self.project_id,
            path=path,
            attach_to={
                "target_type": target_type, "target_id": target_id,
                "role": role, "lens_id": lens_id,
            },
        )
        token = pending["run"].rsplit("/", 1)[-1].rstrip("'")
        response = self.app._client.put(
            f"/api/artifacts/u/{token}", content=body.encode()
        )
        self.assertEqual(response.status_code, 200, response.text)
        return {**response.json(), "artifact_id": pending["artifact_id"]}

    def _pass_review(self, *, exp_id: str, role: str) -> None:
        req = self.call(
            "review.request",
            project_id=self.project_id,
            target_type="experiment",
            target_id=exp_id,
            role=role,
        )
        session = self.call(
            "review.start",
            review_request_id=req["review_request_id"],
            reviewer_capability=req["reviewer_capability"],
            caller_session_id=f"{role}-reviewer",
        )
        self.call(
            "review.submit",
            review_session_id=session["review_session_id"],
            verdict="pass",
            synopsis="The plan and results check out, so the attempt stands.",
        )

    def _store(self, *, path: str, data: bytes, discover_figures: bool = False) -> dict:
        pending = self.call(
            "artifact.upload", project_id=self.project_id, path=path,
            discover_figures=discover_figures,
        )
        token = shlex.split(pending["run"])[-1].rsplit("/", 1)[-1]
        uploaded = self.app._client.put(f"/api/artifacts/u/{token}", content=data)
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        return uploaded.json()

    def test_unattached_binary_has_a_working_download_url(self) -> None:
        data = b"\x00\xff\x89PNG binary evidence"
        artifact = self._store(path="raw.bin", data=data)
        hello = self.app._client.post("/mcp/call", json={
            "name": "agent.hello", "arguments": {},
        })
        self.assertEqual(hello.status_code, 200, hello.text)
        read = self.app._client.post("/mcp/call", json={
            "name": "artifact.read", "arguments": {
                "project_id": self.project_id, "artifact_id": artifact["artifact_id"],
                "include_content": True, "agent_id": hello.json()["result"]["agent_id"],
            },
        })
        self.assertEqual(read.status_code, 200, read.text)
        result = read.json()["result"]
        self.assertTrue(result["download_url"].startswith("http://testserver/api/projects/"))
        self.assertTrue(result["content"]["is_binary"])
        self.assertIsNone(result["content"]["content"])
        downloaded = self.app._client.get(result["download_url"])
        self.assertEqual(downloaded.status_code, 200, downloaded.text)
        self.assertEqual(downloaded.content, data)
        self.assertEqual(downloaded.headers["content-security-policy"], "sandbox")
        self.assertEqual(downloaded.headers["x-content-type-options"], "nosniff")
        self.assertEqual(downloaded.headers["content-disposition"], 'inline; filename="raw.bin"')

    def test_unattached_and_associated_documents_share_file_and_figure_reads(self) -> None:
        body = (VALID_PLAN + "\n![plot](figures/plot.png)\n").encode()
        artifact = self._store(path="plan.md", data=body, discover_figures=True)
        figure_bytes = b"\x89PNG test figure"
        figure_url = shlex.split(artifact["figures"][0]["run"])[-1]
        uploaded = self.app._client.put(figure_url, content=figure_bytes)
        self.assertEqual(uploaded.status_code, 200, uploaded.text)

        def verify_downloads(handle: str) -> None:
            base = f"/api/projects/{self.project_id}/artifacts/{handle}"
            content = self.app._client.get(f"{base}/content")
            self.assertEqual(content.status_code, 200, content.text)
            self.assertEqual(content.json()["content"], body.decode())
            self.assertEqual(self.app._client.get(f"{base}/file").content, body)
            figure = self.app._client.get(f"{base}/figure", params={"rel": "figures/plot.png"})
            self.assertEqual(figure.status_code, 200, figure.text)
            self.assertEqual(figure.content, figure_bytes)
            self.assertEqual(figure.headers["content-security-policy"], "sandbox")
            self.assertEqual(figure.headers["x-content-type-options"], "nosniff")

        verify_downloads(artifact["artifact_id"])
        experiment_id = self.call(
            "experiment.create", project_id=self.project_id,
            name="download-association", intent="Read reused content and figures.",
        )["id"]
        association = self.call(
            "artifact.attach", project_id=self.project_id, artifact_id=artifact["artifact_id"],
            target_type="experiment", target_id=experiment_id, role="plan",
        )["association"]
        self.assertNotEqual(association["id"], artifact["artifact_id"])
        verify_downloads(association["id"])

    def test_foreign_project_downloads_do_not_read_blob_bytes(self) -> None:
        artifact = self._store(path="raw.bin", data=b"\x00private bytes")
        other = self.call("project", action="create", name="Other downloads")["id"]
        base = f"/api/projects/{other}/artifacts/{artifact['artifact_id']}"
        with patch.object(self.app._blobs, "get", side_effect=AssertionError("foreign blob read")) as get:
            for suffix in ("file", "content", "figure?rel=private.png"):
                response = self.app._client.get(f"{base}/{suffix}")
                self.assertEqual(response.status_code, 404, response.text)
            get.assert_not_called()

    def test_arbitrary_filenames_produce_safe_content_disposition_headers(self) -> None:
        cases = (
            ("ordinary file.bin", 'inline; filename="ordinary file.bin"'),
            ('quoted"name.bin', "inline; filename*=UTF-8''quoted%22name.bin"),
            ("文書.bin", "inline; filename*=UTF-8''%E6%96%87%E6%9B%B8.bin"),
            ("report\r\nX-Test: injected.bin", "inline; filename*=UTF-8''report%0D%0AX-Test%3A%20injected.bin"),
        )
        for filename, expected in cases:
            with self.subTest(filename=filename):
                artifact = self._store(path=filename, data=b"raw bytes")
                response = self.app._client.get(
                    f"/api/projects/{self.project_id}/artifacts/{artifact['artifact_id']}/file"
                )
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.content, b"raw bytes")
                self.assertEqual(response.headers["content-disposition"], expected)
                self.assertNotIn("x-test", response.headers)

    def test_generic_content_can_be_read_before_it_is_attached_to_research(self) -> None:
        pending = self.call(
            "artifact.upload", project_id=self.project_id, path="reusable.md"
        )
        token = shlex.split(pending["run"])[-1].rsplit("/", 1)[-1]
        uploaded = self.app._client.put(f"/api/artifacts/u/{token}", content=VALID_PLAN.encode())
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        content_id = pending["artifact_id"]
        read = self.call(
            "artifact.read", project_id=self.project_id,
            artifact_id=content_id, include_content=True,
        )
        self.assertEqual(read["content"]["content"], VALID_PLAN)
        self.assertFalse({"role", "target_id", "attempt_index"} & set(read["artifact"]))
        self.assertEqual(
            self.call("artifact.read", project_id=self.project_id)["artifacts"], []
        )

        handles = []
        for name in ("first-use", "second-use"):
            experiment_id = self.call(
                "experiment.create", project_id=self.project_id,
                name=name, intent="Reuse the same immutable input.",
            )["id"]
            attached = self.call(
                "artifact.attach", project_id=self.project_id, artifact_id=content_id,
                target_type="experiment", target_id=experiment_id, role="plan",
            )
            handles.append(attached["association"]["id"])
            self.assertEqual(attached["artifact_id"], content_id)
            self.assertEqual(attached["association"]["target_id"], experiment_id)
        self.assertNotEqual(*handles)
        foreign = self.call("project", action="create", name="Foreign content")["id"]
        with self.assertRaises(NotFoundError):
            self.call("artifact.read", project_id=foreign, artifact_id=content_id, include_content=True)
        with self.assertRaises(NotFoundError):
            self.call(
                "artifact.attach", project_id=foreign, artifact_id=content_id,
                target_type="experiment", target_id=experiment_id, role="plan",
            )

    def test_full_loop_submit_upload_gate_and_transitions(self) -> None:
        exp_id = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="artifact-loop",
            intent="Prove the artifact submit loop.",
        )["id"]
        # Plan gate blocks until the artifact upload lands.
        with self.assertRaises(Exception):
            self.call(
                "experiment.transition",
                project_id=self.project_id,
                experiment_id=exp_id,
                transition="submit_design",
            )
        self._submit(
            target_type="experiment", target_id=exp_id,
            role="plan", path="plan.md", body=VALID_PLAN,
        )
        self.call(
            "experiment.transition", project_id=self.project_id,
            experiment_id=exp_id, transition="submit_design",
        )
        self._pass_review(exp_id=exp_id, role="design_reviewer")
        self.call(
            "workflow.begin", project_id=self.project_id, instance_id=exp_id,
            expected_revision=self.app.workflows.runtime.get(
                project_id=self.project_id, instance_id=exp_id,
            ).revision,
        )
        self._submit(
            target_type="experiment", target_id=exp_id,
            role="result", path="results.json", body='{"accuracy": 0.72}\n',
        )
        self._submit(
            target_type="experiment", target_id=exp_id,
            role="report", path="report.md", body=VALID_REPORT,
        )
        self._submit(
            target_type="experiment", target_id=exp_id,
            role="graph", path="graph.json", body=VALID_GRAPH,
        )
        self.call(
            "experiment.transition", project_id=self.project_id,
            experiment_id=exp_id, transition="submit_results",
        )
        self._pass_review(exp_id=exp_id, role="experiment_reviewer")
        state = self.call(
            "experiment.get_state", project_id=self.project_id, experiment_id=exp_id,
        )
        self.assertEqual(state["status"], "complete")

    def test_resubmit_invalidates_a_pinned_review(self) -> None:
        exp_id = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="resubmit-invalidates",
            intent="Snapshot invalidation.",
        )["id"]
        self._submit(
            target_type="experiment", target_id=exp_id,
            role="plan", path="plan.md", body=VALID_PLAN,
        )
        self.call(
            "experiment.transition", project_id=self.project_id,
            experiment_id=exp_id, transition="submit_design",
        )
        req = self.call(
            "review.request",
            project_id=self.project_id,
            target_type="experiment",
            target_id=exp_id,
            role="design_reviewer",
        )
        # Resubmitting the plan mints a new artifact id -> the pinned snapshot
        # no longer matches and the review session refuses to start.
        self._submit(
            target_type="experiment", target_id=exp_id,
            role="plan", path="plan.md", body=VALID_PLAN + "Revised.\n",
        )
        with self.assertRaises(Exception):
            self.call(
                "review.start",
                review_request_id=req["review_request_id"],
                reviewer_capability=req["reviewer_capability"],
                caller_session_id="design-reviewer",
            )

    def test_report_must_reference_a_pinned_exhibit_by_basename(self) -> None:
        exp_id = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="exhibit-reference",
            intent="Exhibit basename check.",
        )["id"]
        self._submit(
            target_type="experiment", target_id=exp_id,
            role="plan", path="plan.md", body=VALID_PLAN,
        )
        self.call(
            "experiment.transition", project_id=self.project_id,
            experiment_id=exp_id, transition="submit_design",
        )
        self._pass_review(exp_id=exp_id, role="design_reviewer")
        self.call(
            "workflow.begin", project_id=self.project_id, instance_id=exp_id,
            expected_revision=self.app.workflows.runtime.get(
                project_id=self.project_id, instance_id=exp_id,
            ).revision,
        )
        self.app.artifacts.pin(
            path="experiments/exhibit-reference/metrics_exhibit.json",
            target=ArtifactTarget(
                target_type="experiment",
                target_id=exp_id,
                project_id=self.project_id,
            ),
            role="exhibit",
            data=b'{"kind": "metrics_exhibit"}',
            title="Metrics exhibit",
        )
        self._submit(
            target_type="experiment", target_id=exp_id,
            role="result", path="results.json", body='{"accuracy": 0.72}\n',
        )
        self._submit(
            target_type="experiment", target_id=exp_id,
            role="graph", path="graph.json", body=VALID_GRAPH,
        )
        self._submit(
            target_type="experiment", target_id=exp_id,
            role="report", path="report.md",
            body=VALID_REPORT.replace("Per metrics_exhibit.json, accuracy", "Accuracy"),
        )
        with self.assertRaises(Exception) as caught:
            self.call(
                "experiment.transition", project_id=self.project_id,
                experiment_id=exp_id, transition="submit_results",
            )
        self.assertIn("metrics_exhibit.json", str(caught.exception))
        self._submit(
            target_type="experiment", target_id=exp_id,
            role="report", path="report.md", body=VALID_REPORT,
        )
        self.call(
            "experiment.transition", project_id=self.project_id,
            experiment_id=exp_id, transition="submit_results",
        )

    def test_lens_coverage_keys_on_the_explicit_lens_id(self) -> None:
        wave_id = self.call(
            "reflection.create",
            project_id=self.project_id,
            title="Wave",
            lenses=full_roster(),
        )["id"]
        for lens in full_roster():
            self._submit(
                target_type="reflection", target_id=wave_id,
                role="reflection_lens_doc",
                # File names deliberately do NOT match lens ids: coverage must
                # key on the explicit lens_id field.
                path=f"reflections/notes-{lens['id']}-v2.md",
                body=f"# {lens['id']}\n\n## Summary\nFindings through this lens.\n",
                lens_id=lens["id"],
            )
        state = self.call(
            "reflection.get", project_id=self.project_id, reflection_id=wave_id
        )
        coverage = state["reflection_coverage"]
        self.assertTrue(coverage["complete"], coverage)
        default_lenses = [
            artifact
            for artifact in state["current_attempt_artifacts"]
            if artifact["role"] == "reflection_lens_doc"
        ]
        self.assertEqual(len(default_lenses), 5)
        for artifact in default_lenses:
            self.assertNotIn("content", artifact)
            self.assertEqual(
                artifact["tldr"],
                f"Findings through this lens.",
            )

        deep_dive = self.call(
            "reflection.get",
            project_id=self.project_id,
            reflection_id=wave_id,
            include_content=True,
        )
        full_lenses = [
            artifact
            for artifact in deep_dive["current_attempt_artifacts"]
            if artifact["role"] == "reflection_lens_doc"
        ]
        self.assertEqual(len(full_lenses), 5)
        for artifact in full_lenses:
            self.assertIn("Findings through this lens.", artifact["content"])
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=wave_id,
            transition="submit_reflections",
        )

    def test_oversize_upload_returns_413(self) -> None:
        exp_id = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="oversize",
            intent="Cap enforcement.",
        )["id"]
        pending = self.call(
            "artifact.upload",
            project_id=self.project_id,
            path="plan.md",
            attach_to={"target_type": "experiment", "target_id": exp_id, "role": "plan"},
        )
        token = pending["run"].rsplit("/", 1)[-1].rstrip("'")
        response = self.app._client.put(
            f"/api/artifacts/u/{token}", content=b"x" * 20_000
        )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["max_bytes"], 16_000)

    def test_public_artifact_wire_shapes_are_frozen(self) -> None:
        exp_id = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="contract-shapes",
            intent="Freeze the Artifact V1 wire contract.",
        )["id"]
        body = (VALID_PLAN + "\n![curve](figures/curve.png)\n").encode()
        pending = self.call(
            "artifact.upload",
            project_id=self.project_id,
            path="plans/plan.md",
            attach_to={"target_type": "experiment", "target_id": exp_id, "role": "plan"},
        )
        self.assertEqual(set(pending), {"artifact_id", "run"})
        self.assertTrue(pending["artifact_id"].startswith("art_"))
        upload = shlex.split(pending["run"])
        self.assertEqual(upload[:3], ["curl", "-sf", "-T"])
        self.assertEqual(upload[3], "plans/plan.md")
        self.assertIn("/api/artifacts/u/", upload[4])

        token = upload[4].rsplit("/", 1)[-1]
        completed_response = self.app._client.put(
            f"/api/artifacts/u/{token}", content=body
        )
        self.assertEqual(completed_response.status_code, 200)
        completed = completed_response.json()
        self.assertEqual(
            set(completed),
            {"artifact_id", "role", "path", "sha256", "size_bytes", "figures"},
        )
        self.assertEqual(completed["artifact_id"], pending["artifact_id"])
        self.assertEqual(completed["role"], "plan")
        self.assertEqual(completed["path"], "plans/plan.md")
        self.assertEqual(completed["sha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(completed["size_bytes"], len(body))
        self.assertEqual(len(completed["figures"]), 1)
        figure_instruction = completed["figures"][0]
        self.assertEqual(set(figure_instruction), {"link_path", "run"})
        self.assertEqual(figure_instruction["link_path"], "figures/curve.png")

        figure_bytes = b"\x89PNG contract"
        figure_upload = shlex.split(figure_instruction["run"])
        self.assertEqual(figure_upload[:3], ["curl", "-sf", "-T"])
        self.assertEqual(figure_upload[3], "plans/figures/curve.png")
        figure_token = figure_upload[4].rsplit("/", 1)[-1]
        figure_response = self.app._client.put(
            f"/api/artifacts/f/{figure_token}", content=figure_bytes
        )
        self.assertEqual(figure_response.status_code, 200)
        self.assertEqual(
            figure_response.json(),
            {
                "artifact_id": pending["artifact_id"],
                "link_path": "figures/curve.png",
                "sha256": hashlib.sha256(figure_bytes).hexdigest(),
                "size_bytes": len(figure_bytes),
            },
        )

        listing = self.app._client.get(
            f"/api/projects/{self.project_id}/artifacts",
            params={"target_type": "experiment", "target_id": exp_id},
        ).json()
        self.assertEqual(set(listing), {"count", "artifacts"})
        self.assertEqual(listing["count"], len(listing["artifacts"]))
        self.assertEqual(len(listing["artifacts"]), 1)
        self.assertEqual(
            set(listing["artifacts"][0]),
            {
                "id",
                "target_type",
                "target_id",
                "role",
                "attempt_index",
                "lens_id",
                "path",
                "title",
                "size_bytes",
                "content_type",
                "status",
                "created_by",
                "created_at",
                "updated_at",
            },
        )
        self.assertNotIn("upload_token", listing["artifacts"][0])
        self.assertNotIn("content_sha256", listing["artifacts"][0])
        self.assertNotIn("created_seq", listing["artifacts"][0])

        content = self.app._client.get(
            f"/api/projects/{self.project_id}/artifacts/"
            f"{pending['artifact_id']}/content"
        ).json()
        self.assertEqual(
            set(content),
            {"content", "is_binary", "size_bytes", "content_type", "available"},
        )
        self.assertEqual(content["content"], body.decode())
        self.assertFalse(content["is_binary"])
        self.assertTrue(content["available"])

        file_response = self.app._client.get(
            f"/api/projects/{self.project_id}/artifacts/"
            f"{pending['artifact_id']}/file"
        )
        self.assertEqual(file_response.content, body)
        self.assertEqual(
            file_response.headers["content-type"],
            "text/markdown; charset=utf-8",
        )
        self.assertEqual(
            file_response.headers["content-disposition"],
            'inline; filename="plan.md"',
        )

        figure_read = self.app._client.get(
            f"/api/projects/{self.project_id}/artifacts/"
            f"{pending['artifact_id']}/figure",
            params={"rel": "figures/curve.png"},
        )
        self.assertEqual(figure_read.content, figure_bytes)
        self.assertEqual(
            figure_read.headers["content-type"], "application/octet-stream"
        )

        with self.app._store.connect() as conn:
            event = conn.execute(
                """
                SELECT type, target_type, target_id, payload_json
                FROM events
                WHERE type = 'artifact.submitted' AND target_id = ?
                """,
                (exp_id,),
            ).fetchone()
        self.assertIsNotNone(event)
        self.assertEqual(str(event["target_type"]), "experiment")
        self.assertEqual(str(event["target_id"]), exp_id)
        self.assertEqual(
            json.loads(str(event["payload_json"])),
            {
                "artifact_id": pending["artifact_id"],
                "attempt_index": 1,
                "path": "plans/plan.md",
                "role": "plan",
            },
        )

    def test_lens_id_is_required_by_the_tool_contract(self) -> None:
        with self.assertRaises(ValidationError):
            self.call(
                "artifact.upload",
                project_id=self.project_id,
                path="rigor.md",
                attach_to={
                    "target_type": "reflection", "target_id": "ref_x", "role": "reflection_lens_doc",
                },
            )


class CappedReadOrderingTest(unittest.TestCase):
    """INV-6 (FIX 3): the token-PUT reader rejects on the projected size before
    it extends the buffer, so one huge ASGI chunk is never allocated past the
    cap. A chunk that reports its length but explodes if iterated proves that
    bytearray.extend is unreachable once the cap would be exceeded."""

    def test_read_capped_checks_projected_size_before_extending(self) -> None:
        import asyncio

        from merv.brain.surface.transport.request_body import read_capped_body

        class _UniterableChunk:
            def __len__(self) -> int:
                return 17

            def __iter__(self):  # bytearray.extend falls back to iteration
                raise AssertionError("chunk was buffered before the cap check")

        async def _stream(chunks):
            for chunk in chunks:
                yield chunk

        class _FakeRequest:
            headers: dict[str, str] = {}  # no content-length → streaming path

            def stream(self):
                return _stream([_UniterableChunk()])

        result = asyncio.run(read_capped_body(_FakeRequest(), cap=16))
        self.assertIsNone(result)


class UploadRouteAuthExemptionTest(unittest.TestCase):
    def _request(self, path: str) -> SimpleNamespace:
        return SimpleNamespace(
            method="PUT",
            state=SimpleNamespace(),
            url=SimpleNamespace(path=path),
            headers={},
        )

    def test_token_upload_paths_bypass_the_bearer_gate(self) -> None:
        class RejectingVerifier:
            def verify_bearer(self, _header):
                raise AssertionError("upload routes must never reach the verifier")

        authenticator = RequestAuthenticator(
            surface=HttpSurfacePolicy.for_surface(
                restrict_cors=True, hosted_control=True
            ),
            verifier=RejectingVerifier(),
        )
        for path in ("/api/artifacts/u/tok_1", "/api/artifacts/f/tok_2"):
            self.assertIsNone(authenticator.authenticate(self._request(path)))


class ArtifactRouteContractTest(unittest.TestCase):
    def test_artifact_router_method_and_path_inventory_is_frozen(self) -> None:
        routes = {
            (method, route.path)
            for route in build_router(artifacts=object()).routes
            for method in route.methods
        }
        self.assertEqual(
            routes,
            {
                ("PUT", "/api/artifacts/u/{token}"),
                ("PUT", "/api/artifacts/f/{token}"),
                ("GET", "/api/projects/{project_id}/artifacts"),
                (
                    "GET",
                    "/api/projects/{project_id}/artifacts/{artifact_id}/content",
                ),
                (
                    "GET",
                    "/api/projects/{project_id}/artifacts/{artifact_id}/file",
                ),
                (
                    "GET",
                    "/api/projects/{project_id}/artifacts/{artifact_id}/figure",
                ),
            },
        )


if __name__ == "__main__":
    unittest.main()
