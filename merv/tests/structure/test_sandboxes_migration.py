"""Cutover export secrecy and guarded legacy upload-reference conversion."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


def migration():
    path = Path(__file__).parents[2] / "deploy" / "migrate_to_sandboxes.py"
    spec = importlib.util.spec_from_file_location("merv_migration", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_export_keeps_credentials_private_and_refuses_overwrite(
    tmp_path, monkeypatch, capsys
):
    module = migration()
    environment = {
        "MERV_BLOB_BUCKET": "old-blobs",
        "AWS_ACCESS_KEY_ID": "private-access",
        "AWS_SECRET_ACCESS_KEY": "private-secret",
        "MERV_STORAGE_BUCKET": "old-heavy",
        "MERV_STORAGE_ENDPOINT_URL": "https://s3.example.test",
        "MERV_STORAGE_ACCESS_KEY_ID": "private-heavy-access",
        "MERV_STORAGE_SECRET_ACCESS_KEY": "private-heavy-secret",
    }
    inspected = {
        "Image": "sha256:old",
        "Config": {
            "Env": [f"{k}={v}" for k, v in environment.items()],
            "Labels": {"com.docker.compose.project.working_dir": "/old-release"},
        },
    }

    def docker(*args):
        if args[0] == "inspect":
            return json.dumps([inspected])
        return json.dumps({"active_sandboxes": 0, "storage_objects": []})

    monkeypatch.setattr(module, "docker", docker)
    output = tmp_path / "source.json"
    args = SimpleNamespace(
        source_control="old-control",
        source_database="old-database",
        blob_endpoint="https://merv.example.test",
        export=str(output),
    )
    module.export_source(args)
    assert output.stat().st_mode & 0o777 == 0o600
    assert (
        json.loads(output.read_text())["heavy"]["aws_secret_access_key"]
        == "private-heavy-secret"
    )
    assert "private-secret" not in capsys.readouterr().out
    with pytest.raises(FileExistsError):
        module.export_source(args)


def test_export_refuses_active_legacy_sandboxes(tmp_path, monkeypatch):
    module = migration()

    def docker(*args):
        if args[0] == "inspect":
            return json.dumps([{"Config": {"Env": []}}])
        return json.dumps({"active_sandboxes": 1, "storage_objects": []})

    monkeypatch.setattr(module, "docker", docker)
    args = SimpleNamespace(
        source_control="old", source_database="db", export=str(tmp_path / "source")
    )
    with pytest.raises(SystemExit, match="legacy sandboxes are active"):
        module.export_source(args)
    assert not Path(args.export).exists()


def test_mapping_requires_success_and_updates_both_references_atomically(
    tmp_path, monkeypatch
):
    module = migration()
    report = tmp_path / "report.json"
    args = SimpleNamespace(apply_upload_mapping=str(report), source_database="db")
    report.write_text(json.dumps({"applied": False, "failures": []}))
    with pytest.raises(SystemExit, match="successful applied"):
        module.apply_upload_mapping(args)
    report.write_text(
        json.dumps(
            {
                "applied": True,
                "failures": [],
                "upload_id_mapping": [
                    {
                        "id": "sto_1",
                        "project_id": "proj_1",
                        "old_upload_id": "upload_'old",
                        "new_upload_id": "msbx_new",
                        "sha256": "a" * 64,
                        "size_bytes": "10",
                    }
                ],
            }
        )
    )
    calls = []
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda command, **kwargs: calls.append((command, kwargs)),
    )
    module.apply_upload_mapping(args)
    command, kwargs = calls[0]
    assert "ON_ERROR_STOP=1" in command and kwargs["check"]
    sql = kwargs["input"]
    assert sql.startswith("BEGIN;") and sql.rstrip().endswith("COMMIT;")
    assert "upload_''old" in sql
    assert "legacy upload changed after migration snapshot" in sql
    assert "UPDATE storage_objects" in sql and "UPDATE storage_completion_tokens" in sql
    assert "t.object_id=m.id" in sql and "s.upload_id IS NULL" in sql
