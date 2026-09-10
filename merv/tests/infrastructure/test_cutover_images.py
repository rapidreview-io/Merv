"""Opt-in packaging checks for the release images built from the current trees."""

import json
import os
import subprocess

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("MERV_CUTOVER_IMAGE_REHEARSAL") != "1",
    reason="requires locally built current release images",
)


def docker(*args):
    result = subprocess.run(
        ["docker", *args], capture_output=True, check=False, timeout=60
    )
    if result.returncode:
        raise RuntimeError("disposable image check Docker operation failed")
    return result.stdout


def test_packaged_merv_reads_private_consumer_file_without_native_sdk(tmp_path):
    image = os.environ["MERV_CUTOVER_CURRENT_MERV_IMAGE"]
    connection = tmp_path / "connections.json"
    connection.write_text(
        json.dumps(
            {"proj_image": {"namespace": "team-one", "token": "sbxt_fixture_only"}}
        )
    )
    connection.chmod(0o600)
    # The operator's documented installation step sets ownership for the image's
    # service UID. The actual file is mounted read-only, as with local Compose.
    docker(
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--user",
        "0",
        "--mount",
        f"type=bind,source={tmp_path.resolve()},target=/fixture",
        "--entrypoint",
        "python",
        image,
        "-c",
        "import os; os.chown('/fixture/connections.json',10001,10001)",
    )
    program = """import importlib.util,json,os,pathlib
from merv.brain.infrastructure.client import build_infrastructure_client
p=pathlib.Path('/run/secrets/consumer')
assert os.getuid()==10001
assert p.stat().st_mode & 0o777 == 0o600 and p.stat().st_uid==10001
assert importlib.util.find_spec('merv_sandboxes') is None
assert importlib.util.find_spec('merv.brain.infrastructure.budget') is None
client=build_infrastructure_client()
assert client.namespace_for_project('proj_image')=='team-one'
client.close()
print(json.dumps({'uid':os.getuid(),'private_connection_readable':True,'native_sdk_absent':True,'local_budget_engine_absent':True}))
"""
    result = json.loads(
        docker(
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            "none",
            "--mount",
            f"type=bind,source={connection.resolve()},target=/run/secrets/consumer,readonly",
            "-e",
            "MERV_SANDBOXES_URL=https://example.invalid",
            "-e",
            "MERV_SANDBOXES_CONNECTIONS_FILE=/run/secrets/consumer",
            "--entrypoint",
            "python",
            image,
            "-c",
            program,
        )
    )
    assert result == {
        "uid": 10001,
        "private_connection_readable": True,
        "native_sdk_absent": True,
        "local_budget_engine_absent": True,
    }


def test_packaged_native_imports_independently_without_merv():
    image = os.environ["MERV_CUTOVER_CURRENT_NATIVE_IMAGE"]
    program = """import importlib.util,json,os
from merv_sandboxes.registry import CreateSandboxRequest
from merv_sandboxes.account_import import AccountImport,manifest_fingerprint
assert os.getuid()==10001
assert importlib.util.find_spec('merv') is None
assert 'preserve_existing_authority' in AccountImport.model_fields
assert callable(manifest_fingerprint)
print(json.dumps({'uid':os.getuid(),'merv_dependency_absent':True,'generic_import_available':True}))
"""
    result = json.loads(
        docker(
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            "none",
            "--entrypoint",
            "python",
            image,
            "-c",
            program,
        )
    )
    assert result == {
        "uid": 10001,
        "merv_dependency_absent": True,
        "generic_import_available": True,
    }
