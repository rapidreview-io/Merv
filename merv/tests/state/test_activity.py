"""Tests for bounded activity-log reads and result payload capping."""

from __future__ import annotations

import json
import unittest

from merv.brain.kernel.state.activity import (
    RESULT_LOG_MAX_BYTES,
    ToolActivityEmitter,
    cap_result,
    redact_sensitive,
    register_activity_vocabulary,
    scrub_secret_text,
)
from merv.brain.research_core import ACTIVITY_VOCABULARY
from merv.brain.surface.telemetry import ControlActivitySink

# `reviewer_capability` is Research's field name, and Kernel has never heard
# of it: it is redacted because Research declared it at composition, which is
# what Surface does before it builds anything that can log.
register_activity_vocabulary(**ACTIVITY_VOCABULARY)

# A realistic storage.submit result: bytes go direct to S3 via a presigned PUT,
# and the ledger is finalized through the one-time completion token — both live
# inside the `run` command string value.
_PRESIGNED = (
    "https://bucket.s3.amazonaws.com/proj/abc?"
    "X-Amz-Algorithm=AWS4-HMAC-SHA256&"
    "X-Amz-Credential=AKIAEXAMPLE%2F20260723%2Fus-east-1%2Fs3%2Faws4_request&"
    "X-Amz-Date=20260723T000000Z&X-Amz-Expires=3600&"
    "X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeefcafef00dsignature"
)
_S3_SIG_PARAMS = ("X-Amz-Signature=", "X-Amz-Credential=", "X-Amz-Security-Token=")


class CapResultTest(unittest.TestCase):
    def test_small_result_passes_through(self) -> None:
        value = {"projects": [{"id": "proj_1"}]}
        self.assertEqual(cap_result(value=value), value)

    def test_sensitive_result_fields_are_redacted(self) -> None:
        value = {
            "reviewer_capability": "rp_secret",
            "nested": {
                "capability": "rp_nested",
                "env": {"MLFLOW_TRACKING_PASSWORD": "rr_sk_agent"},
            },
            "tuple": ({"MLFLOW_TRACKING_PASSWORD": "tuple-secret"},),
        }
        self.assertEqual(
            cap_result(value=value),
            {
                "reviewer_capability": "[redacted]",
                "nested": {
                    "capability": "[redacted]",
                    "env": {"MLFLOW_TRACKING_PASSWORD": "[redacted]"},
                },
                "tuple": ({"MLFLOW_TRACKING_PASSWORD": "[redacted]"},),
            },
        )

    def test_the_durable_path_also_scrubs_credential_shapes(self) -> None:
        """The ring keeps the raw text the debug UI drills into; the record
        that lives on disk for 180 days runs the shape scrubber too."""
        value = {"run": "curl -H 'x-key: rr_sk_live0123456789'"}
        self.assertIn("rr_sk_live", redact_sensitive(value=value)["run"])
        self.assertNotIn(
            "rr_sk_live",
            redact_sensitive(value=value, credentials=True)["run"],
        )

    def test_presigned_url_signature_scrubbed_from_result_values(self) -> None:
        # INV-12 value-level scrubbing: a presigned S3 URL is a ~1-hour
        # replayable credential; its SigV4 signature params must never reach the
        # activity log even when embedded in a string value like `run`.
        run = (
            "curl -sf -X PUT -H 'x-amz-checksum-sha256:aGVsbG8=' -T 'model.bin' "
            f"'{_PRESIGNED}' && curl -sf -X POST "
            "'http://127.0.0.1:8787/api/storage/u/tok_SECRET/complete'"
        )
        value = {"object": {"id": "sto_1"}, "run": run, "upload_id": "upload_1"}
        scrubbed = cap_result(value=value)
        serialized = json.dumps(scrubbed)
        for param in _S3_SIG_PARAMS:
            self.assertNotIn(param, serialized)
        # The signed access key id and the completion token are both gone.
        self.assertNotIn("AKIAEXAMPLE", serialized)
        self.assertNotIn("tok_SECRET", serialized)
        # The command structure survives so the log stays legible.
        self.assertIn("/api/storage/u/<redacted>/complete", scrubbed["run"])
        self.assertIn("x-amz-checksum-sha256:aGVsbG8=", scrubbed["run"])
        self.assertEqual(scrubbed["object"], {"id": "sto_1"})

    def test_scrub_secret_text_is_precise(self) -> None:
        # The SigV4 params are dropped entirely; the URL host/key survives, and
        # non-token /api paths pass through untouched.
        cleaned = scrub_secret_text(_PRESIGNED)
        self.assertNotIn("X-Amz-Signature=", cleaned)
        self.assertNotIn("X-Amz-Credential=", cleaned)
        self.assertNotIn("AKIAEXAMPLE", cleaned)
        self.assertIn("<redacted>", cleaned)
        self.assertIn("bucket.s3.amazonaws.com/proj/abc", cleaned)
        self.assertEqual(
            scrub_secret_text("/api/artifacts/u/tok_x"), "/api/artifacts/u/<redacted>"
        )
        # feed.post returns its one-time upload token inside `run`; the value
        # scrubber must cover /api/feed/u the same as the HTTP-path scrubber, or
        # the bearer token persists unredacted in tool telemetry (INV-12).
        self.assertEqual(
            scrub_secret_text("/api/feed/u/tok_feed"), "/api/feed/u/<redacted>"
        )
        self.assertEqual(
            scrub_secret_text("/api/projects/p_1/storage"), "/api/projects/p_1/storage"
        )
        # A plain string with no secrets is returned unchanged (fast path).
        self.assertEqual(scrub_secret_text("nothing to see"), "nothing to see")
        self.assertIsInstance(redact_sensitive(value="nothing to see"), str)

    def test_oversized_result_is_truncated(self) -> None:
        value = {"blob": "x" * (RESULT_LOG_MAX_BYTES + 1000)}
        capped = cap_result(value=value)
        self.assertTrue(capped["_truncated"])
        self.assertGreater(capped["_bytes"], RESULT_LOG_MAX_BYTES)
        self.assertLessEqual(len(capped["preview"]), 2048)
        # The capped marker itself stays small.
        self.assertLessEqual(
            len(json.dumps(capped)), RESULT_LOG_MAX_BYTES // 2
        )


class InMemoryActivityTest(unittest.TestCase):
    def test_control_sink_reuses_the_canonical_tool_event_methods(self) -> None:
        self.assertIs(ControlActivitySink.tool_ok, ToolActivityEmitter.tool_ok)
        self.assertIs(ControlActivitySink.tool_error, ToolActivityEmitter.tool_error)

    def test_event_filter_applies_before_limit(self) -> None:
        sink = ControlActivitySink()
        sink.tool_ok(
            source="mcp",
            tool="claim.list",
            arguments={"project_id": "p1"},
            duration_ms=1,
            result={"claims": []},
        )
        sink.tool_ok(
            source="mcp",
            tool="claim.list",
            arguments={"project_id": "p2"},
            duration_ms=1,
            result={"claims": []},
        )
        recent = sink.recent(
            limit=1,
            source="mcp",
            event_filter=lambda event: event.get("args", {}).get("project_id") == "p1",
        )
        self.assertEqual(len(recent["events"]), 1)
        self.assertEqual(recent["events"][0]["args"]["project_id"], "p1")

    def test_summary_counts_the_rows_the_filters_kept(self) -> None:
        """TEL-01: a filtered read must not carry unfiltered totals."""
        sink = ControlActivitySink()
        for source, project in (("mcp", "p1"), ("http", "p2"), ("http", "p3")):
            sink.tool_ok(
                source=source,
                tool="claim.list",
                arguments={"project_id": project},
                duration_ms=1,
                result={"claims": []},
            )
        unfiltered = sink.recent(limit=10)
        self.assertEqual(unfiltered["summary"]["total"], 3)

        by_source = sink.recent(limit=10, source="http")
        self.assertEqual(len(by_source["events"]), 2)
        self.assertEqual(by_source["summary"]["total"], 2)
        self.assertEqual(by_source["summary"]["source_counts"], {"http": 2})
        self.assertEqual(by_source["summary"]["window"], 2)

        # The API view recomputes this summary for every response, so the two
        # summarizers must agree on the shape — a key in one and not the other
        # silently changes the local/unscoped response schema (audit TEL-01).
        from merv.brain.surface.transport.api.views import (
            _activity_summary as api_activity_summary,
        )

        self.assertEqual(
            set(unfiltered["summary"]),
            set(api_activity_summary(unfiltered["scanned_filtered"])),
        )

        by_project = sink.recent(
            limit=10,
            event_filter=lambda event: event.get("args", {}).get("project_id") == "p1",
        )
        self.assertEqual(by_project["summary"]["total"], 1)
        self.assertEqual(
            sum(by_project["summary"]["status_counts"].values()),
            len(by_project["events"]),
        )

    def test_tool_ok_records_true_io_sizes_even_when_capped(self) -> None:
        sink = ControlActivitySink()
        big = "z" * (RESULT_LOG_MAX_BYTES + 5000)
        sink.tool_ok(
            source="mcp",
            tool="experiment.get_state",
            arguments={"experiment_id": "exp_1"},
            duration_ms=12,
            result={"blob": big},
        )
        event = sink.recent(limit=1)["events"][0]
        self.assertTrue(event["result"]["_truncated"])
        self.assertGreater(event["received_chars"], RESULT_LOG_MAX_BYTES)
        self.assertGreater(event["sent_chars"], 0)

    def test_tool_error_records_sent_and_error_size(self) -> None:
        sink = ControlActivitySink()
        sink.tool_error(
            source="mcp",
            tool="sandbox.request",
            arguments={"experiment_id": "exp_1"},
            duration_ms=4,
            error="boom",
            error_code="bad",
        )
        event = sink.recent(limit=1)["events"][0]
        self.assertEqual(event["received_chars"], len("boom"))
        self.assertGreater(event["sent_chars"], 0)


if __name__ == "__main__":
    unittest.main()
