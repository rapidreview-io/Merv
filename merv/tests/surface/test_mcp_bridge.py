from __future__ import annotations

import io
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from merv.client.mcp_bridge import (
    DEVICE_GRANT,
    BridgeError,
    CredentialStore,
    McpBridge,
    OAuthDeviceClient,
    normalize_resource,
    serve_stdio,
    sse_messages,
)


RESOURCE = "https://merv.example/mcp"
ORIGIN = "https://merv.example"


class CredentialStoreTest(unittest.TestCase):
    def test_atomic_store_is_owner_only_and_keyed_by_resource(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "private" / "oauth.json"
            store = CredentialStore(path)
            store.put(RESOURCE, {"access_token": "mk_access"})
            self.assertEqual(store.get(RESOURCE), {"access_token": "mk_access"})
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            self.assertTrue(store.remove(RESOURCE))
            self.assertIsNone(store.get(RESOURCE))
            self.assertFalse(store.remove(RESOURCE))

    def test_rejects_insecure_or_indirect_store(self) -> None:
        if os.name == "nt":
            self.skipTest("POSIX permission contract")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            insecure = root / "oauth.json"
            insecure.write_text("{}")
            insecure.chmod(0o644)
            with self.assertRaisesRegex(BridgeError, "chmod 600"):
                CredentialStore(insecure).get(RESOURCE)
            target = root / "target.json"
            target.write_text("{}")
            target.chmod(0o600)
            link = root / "link.json"
            link.symlink_to(target)
            with self.assertRaisesRegex(BridgeError, "regular file"):
                CredentialStore(link).get(RESOURCE)

    def test_resource_validation_allows_https_and_loopback_only(self) -> None:
        self.assertEqual(normalize_resource("https://MERV.EXAMPLE/mcp/"), RESOURCE)
        self.assertEqual(
            normalize_resource("http://127.0.0.1:8787/mcp"),
            "http://127.0.0.1:8787/mcp",
        )
        for bad in (
            "http://merv.example/mcp",
            "https://user:secret@merv.example/mcp",
            "https://merv.example/mcp?token=no",
        ):
            with self.subTest(url=bad), self.assertRaises(BridgeError):
                normalize_resource(bad)


class DeviceLoginTest(unittest.TestCase):
    def test_device_login_registers_polls_and_persists_refreshable_oauth(self) -> None:
        calls: list[tuple[str, object, object]] = []
        responses = iter(
            [
                (
                    200,
                    {},
                    {
                        "issuer": ORIGIN,
                        "registration_endpoint": f"{ORIGIN}/oauth/register",
                        "device_authorization_endpoint": f"{ORIGIN}/oauth/device_authorization",
                        "token_endpoint": f"{ORIGIN}/oauth/token",
                    },
                ),
                (201, {}, {"client_id": "oauthc_1"}),
                (
                    200,
                    {},
                    {
                        "device_code": "secret-device-code",
                        "user_code": "ABCD-EFGH",
                        "verification_uri": "https://ui.example/oauth/device",
                        "verification_uri_complete": "https://ui.example/oauth/device?user_code=ABCD-EFGH",
                        "expires_in": 600,
                        "interval": 1,
                    },
                ),
                (400, {}, {"error": "authorization_pending"}),
                (
                    200,
                    {},
                    {
                        "access_token": "mk_access",
                        "refresh_token": "mrt_refresh",
                        "expires_in": 3600,
                    },
                ),
            ]
        )

        def request(url, *, form=None, json_body=None, **_kwargs):
            calls.append((url, form, json_body))
            status, headers, body = next(responses)
            return status, headers, json.dumps(body).encode()

        with tempfile.TemporaryDirectory() as tmp:
            store = CredentialStore(Path(tmp) / "oauth.json")
            client = OAuthDeviceClient(resource=RESOURCE, store=store, request=request)
            output = io.StringIO()
            credential = client.login(
                output=output, sleep=lambda _seconds: None, now=lambda: 100.0
            )
            self.assertEqual(credential["access_token"], "mk_access")
            self.assertEqual(credential["refresh_token"], "mrt_refresh")
            self.assertEqual(credential["expires_at"], 3700.0)
            self.assertNotIn("secret-device-code", output.getvalue())
            self.assertIn("ABCD-EFGH", output.getvalue())
            self.assertEqual(
                calls[1][2]["grant_types"], [DEVICE_GRANT, "refresh_token"]
            )
            self.assertEqual(calls[-1][1]["device_code"], "secret-device-code")
            self.assertEqual(store.get(RESOURCE)["client_id"], "oauthc_1")

    def test_discovery_refuses_cross_origin_token_endpoint(self) -> None:
        def request(_url, **_kwargs):
            return (
                200,
                {},
                json.dumps(
                    {
                        "issuer": ORIGIN,
                        "registration_endpoint": f"{ORIGIN}/oauth/register",
                        "device_authorization_endpoint": f"{ORIGIN}/oauth/device_authorization",
                        "token_endpoint": "https://attacker.example/token",
                    }
                ).encode(),
            )

        client = OAuthDeviceClient(
            resource=RESOURCE, store=CredentialStore(Path("unused")), request=request
        )
        with self.assertRaisesRegex(BridgeError, "Merv server origin"):
            client.discovery()


class BridgeProtocolTest(unittest.TestCase):
    def test_sse_parser_emits_each_json_rpc_message(self) -> None:
        stream = io.BytesIO(
            b': keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'
            b'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'
        )
        messages = list(sse_messages(stream))
        self.assertEqual(messages[0]["method"], "notifications/progress")
        self.assertEqual(messages[1]["id"], 1)

    def test_unauthorized_post_refreshes_once_and_preserves_initialize(self) -> None:
        class OAuth:
            resource = RESOURCE

            def __init__(self):
                self.forces: list[bool] = []

            def access_token(self, *, force_refresh=False):
                self.forces.append(force_refresh)
                return "fresh" if force_refresh else "stale"

        oauth = OAuth()
        bridge = McpBridge(oauth=oauth)  # type: ignore[arg-type]
        posts: list[tuple[str, str]] = []

        def post(*, payload, token, emit):
            posts.append((payload["method"], token))
            if token == "stale":
                return 401
            emit({"jsonrpc": "2.0", "id": 1, "result": {}})
            return 200

        bridge._post = post  # type: ignore[method-assign]
        emitted: list[dict] = []
        bridge.send(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18"},
            },
            emitted.append,
        )
        self.assertEqual(oauth.forces, [False, True])
        self.assertEqual(posts, [("initialize", "stale"), ("initialize", "fresh")])
        self.assertEqual(bridge.protocol_version, "2025-06-18")
        self.assertEqual(emitted[0]["id"], 1)

    def test_stdio_returns_protocol_error_without_leaking_to_stdout(self) -> None:
        class BrokenBridge:
            def send(self, payload, emit):
                raise BridgeError("sign in again")

        output = io.StringIO()
        errors = io.StringIO()
        code = serve_stdio(
            BrokenBridge(),  # type: ignore[arg-type]
            input=io.StringIO('{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n'),
            output=output,
            errors=errors,
        )
        self.assertEqual(code, 0)
        response = json.loads(output.getvalue())
        self.assertEqual(response["id"], 7)
        self.assertEqual(response["error"]["message"], "sign in again")
        self.assertEqual(errors.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
