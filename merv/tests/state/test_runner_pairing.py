from __future__ import annotations

import hashlib
import secrets
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from merv.brain.kernel.state import StateStore
from merv.brain.kernel.utils import (
    GoneError,
    NotFoundError,
    ThrottledError,
    ValidationError,
    format_iso,
    now_iso,
)
from merv.brain.surface.project_keys import ProjectKeys
from merv.brain.surface.runner_pairing import (
    APPROVAL_MISS_LIMIT,
    APPROVED_READ_WINDOW_SECONDS,
    CREATE_PER_IP_PER_MINUTE,
    RunnerPairings,
    format_user_code,
)


def _key_and_digest() -> tuple[str, str]:
    key = "mk_" + secrets.token_urlsafe(32)
    return key, hashlib.sha256(key.encode("utf-8")).hexdigest()


class RunnerPairingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.store = StateStore(db_path=Path(self.temp.name) / "state.sqlite")
        with self.store.transaction() as tx:
            tx.execute(
                "INSERT INTO projects (id, name, created_at) VALUES ('proj_1', 'Project', ?)",
                (now_iso(),),
            )
        self.keys = ProjectKeys(store=self.store)
        self.pairings = RunnerPairings(store=self.store, project_keys=self.keys)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _create(self, *, ip: str = "10.0.0.1", digest: str | None = None) -> dict:
        if digest is None:
            _, digest = _key_and_digest()
        return self.pairings.create(
            key_digest=digest,
            runner_id="runner-uuid",
            machine={"hostname": "lucia.local", "system": "Darwin", "architecture": "arm64"},
            client_ip=ip,
        )

    def test_happy_path_registers_digest_and_token_is_idempotent(self) -> None:
        key, digest = _key_and_digest()
        created = self._create(digest=digest)
        self.assertEqual(len(created["user_code"]), 8)
        self.assertEqual(format_user_code(created["user_code"]), f"{created['user_code'][:4]}-{created['user_code'][4:]}")
        self.assertEqual(self.pairings.token(device_code=created["device_code"])["status"], "pending")

        approved = self.pairings.approve(
            project_id="proj_1",
            user_code=format_user_code(created["user_code"]).lower(),
            owner_user_id="user-a",
            principal_label="user:user-a",
        )
        self.assertEqual(approved["key"]["label"], "auto-run · lucia.local")
        self.assertEqual(approved["machine"]["hostname"], "lucia.local")
        key_id = approved["key"]["id"]
        self.assertNotIn("runner_id", approved)  # identity stays private
        self.assertEqual(len(approved["runner_ref"]), 24)
        # The plaintext key the runner generated now authenticates.
        record = self.keys.verify_secret(secret=key)
        self.assertIsNotNone(record)
        self.assertEqual(record.project_id, "proj_1")
        self.assertEqual(record.label, "auto-run · lucia.local")

        first = self.pairings.token(device_code=created["device_code"])
        second = self.pairings.token(device_code=created["device_code"])
        self.assertEqual(first["status"], "approved")
        self.assertEqual(first, second)  # idempotent within the read window
        self.assertEqual(first["project_id"], "proj_1")
        self.assertEqual(first["project_name"], "Project")
        self.assertEqual(first["runner_id"], f"key:{key_id}/runner-uuid")

    def test_token_is_gone_after_the_read_window(self) -> None:
        created = self._create()
        self.pairings.approve(
            project_id="proj_1",
            user_code=created["user_code"],
            owner_user_id="user-a",
            principal_label="user:user-a",
        )
        with self.store.transaction() as tx:
            tx.execute(
                "UPDATE agent_runner_pairings SET approved_at = ?",
                (
                    format_iso(
                        datetime.now(UTC)
                        - timedelta(seconds=APPROVED_READ_WINDOW_SECONDS + 5)
                    ),
                ),
            )
        with self.assertRaises(GoneError):
            self.pairings.token(device_code=created["device_code"])

    def test_expired_pending_code_cannot_be_approved_or_read(self) -> None:
        created = self._create()
        with self.store.transaction() as tx:
            tx.execute(
                "UPDATE agent_runner_pairings SET expires_at = ?",
                (format_iso(datetime.now(UTC) - timedelta(seconds=1)),),
            )
        with self.assertRaises(NotFoundError):
            self.pairings.approve(
                project_id="proj_1",
                user_code=created["user_code"],
                owner_user_id="user-a",
                principal_label="user:user-a",
            )
        with self.assertRaises(GoneError):
            self.pairings.token(device_code=created["device_code"])

    def test_unknown_device_code_and_bad_inputs(self) -> None:
        with self.assertRaises(GoneError):
            self.pairings.token(device_code="not-a-real-code")
        with self.assertRaises(ValidationError):
            self._create(digest="short")
        with self.assertRaises(ValidationError):
            self.pairings.approve(
                project_id="proj_1",
                user_code="ZZ",
                owner_user_id="user-a",
                principal_label="user:user-a",
            )

    def test_approval_misses_throttle_per_principal(self) -> None:
        for _ in range(APPROVAL_MISS_LIMIT):
            with self.assertRaises(NotFoundError):
                self.pairings.approve(
                    project_id="proj_1",
                    user_code="0000AAAA",
                    owner_user_id="user-a",
                    principal_label="user:user-a",
                )
        with self.assertRaises(ThrottledError):
            self.pairings.approve(
                project_id="proj_1",
                user_code="0000AAAA",
                owner_user_id="user-a",
                principal_label="user:user-a",
            )
        # A different principal is unaffected and a real code still works.
        created = self._create()
        approved = self.pairings.approve(
            project_id="proj_1",
            user_code=created["user_code"],
            owner_user_id="user-b",
            principal_label="user:user-b",
        )
        self.assertTrue(approved["key"]["id"].startswith("mkey"))

    def test_creation_is_throttled_per_ip_and_digest_is_single_use(self) -> None:
        for _ in range(CREATE_PER_IP_PER_MINUTE):
            # Pending-per-IP cap is lower than the per-minute cap, so approve
            # each one to keep the pending count at zero.
            created = self._create(ip="10.9.9.9")
            self.pairings.approve(
                project_id="proj_1",
                user_code=created["user_code"],
                owner_user_id="user-a",
                principal_label="user:user-a",
            )
        with self.assertRaises(ThrottledError):
            self._create(ip="10.9.9.9")
        _, digest = _key_and_digest()
        self._create(ip="10.1.1.1", digest=digest)
        with self.assertRaises(ValidationError):
            self._create(ip="10.1.1.2", digest=digest)

    def test_approve_rollback_leaves_no_key_row(self) -> None:
        created = self._create()
        with self.assertRaises(NotFoundError):
            # Unknown project: register_digest raises inside the transaction.
            self.pairings.approve(
                project_id="proj_missing",
                user_code=created["user_code"],
                owner_user_id="user-a",
                principal_label="user:user-a",
            )
        with self.store.connect() as conn:
            keys = conn.execute("SELECT COUNT(*) AS n FROM project_api_keys").fetchone()
            row = conn.execute(
                "SELECT status FROM agent_runner_pairings"
            ).fetchone()
        self.assertEqual(int(keys["n"]), 0)
        self.assertEqual(row["status"], "pending")


if __name__ == "__main__":
    unittest.main()
