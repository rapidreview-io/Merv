"""Read-only mapping checks and bounded resume coverage, without live storage."""
from copy import deepcopy
import importlib.util
from pathlib import Path
import sys
from unittest.mock import patch

import pytest

from merv.brain.infrastructure.storage import _encode_upload
from tests.structure.test_sandboxes_verifier import verifier

spec = importlib.util.spec_from_file_location('mapping_verifier', Path(__file__).resolve().parents[2] / 'deploy' / 'verify_migrated_uploads.py')
mapping = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'verify_sandboxes_cutover': verifier}):
    spec.loader.exec_module(mapping)


def fixture():
    rows = []
    native = {}
    for row_id, oid, state, size in [('sto_a', 'obj_a', 'available', 10), ('sto_b', 'obj_a', 'available', 10),
                                     ('sto_c', 'obj_c', 'uploading', 100), ('sto_d', 'obj_d', 'uploading', 200)]:
        sha = ('a' if oid == 'obj_a' else 'c' if oid == 'obj_c' else 'd') * 64
        rows.append({'id': row_id, 'project_id': 'proj_smoke', 'namespace': 'proj_smoke', 'content_sha256': sha,
                     'size_bytes': size, 'upload_id': _encode_upload('proj_smoke', oid, row_id=row_id)})
        native[oid] = {'id': oid, 'namespace': 'merv-project-proj_smoke', 'name': sha, 'sha256': sha,
                       'size_bytes': size, 'state': state, 'content_type': 'application/octet-stream'}
    return rows, native


class Client:
    def __init__(self, records):
        self.records = records
        self.calls = []

    def namespace_for_project(self, project_id):
        assert project_id == "proj_smoke"
        return "merv-project-proj_smoke"

    def request(self, method, path, *, namespace, **kwargs):
        assert method == 'GET'
        self.calls.append((method, path, namespace))
        oid = path.split('/')[3]
        record = deepcopy(self.records[oid])
        if path.endswith('/upload'):
            return {'object': record, 'part_size': 1024, 'part_count': 1,
                    'parts': [] if record['state'] == 'available' else [{'part_number': 1, 'size_bytes': record['size_bytes'], 'url': 'https://storage.test/?token=do-not-print'}]}
        return record


def test_checks_every_row_caches_native_objects_and_resumes_only_two(capsys):
    rows, objects = fixture()
    client = Client(objects)
    result = mapping.verify_pending(client, rows, expected=4)
    assert result == {'pending_rows': 4, 'unique_handles': 4, 'native_objects': 3, 'resumed_targets': 2, 'transferred_bytes': 0}
    assert len(client.calls) == 5
    assert [path for _, path, _ in client.calls if path.endswith('/upload')] == ['/storage/objects/obj_a/upload', '/storage/objects/obj_c/upload']
    output = capsys.readouterr().out
    assert 'do-not-print' not in output and 'msbx_' not in output


@pytest.mark.parametrize('problem', ['duplicate', 'foreign_row', 'foreign_namespace', 'wrong_size'])
def test_rejects_invalid_migration_identity_or_canonical_metadata(problem):
    rows, objects = fixture()
    if problem == 'duplicate':
        rows[1]['upload_id'] = rows[0]['upload_id']
    elif problem == 'foreign_row':
        rows[0]['upload_id'] = _encode_upload('proj_smoke', 'obj_a', row_id='sto_foreign')
    elif problem == 'foreign_namespace':
        rows[0]['upload_id'] = _encode_upload('proj_other', 'obj_a', row_id='sto_a')
    else:
        objects['obj_a']['size_bytes'] = 999
    with pytest.raises(verifier.CheckFailed):
        mapping.verify_pending(Client(objects), rows, expected=4)


def test_rejects_resume_that_loses_the_row_specific_handle():
    rows, objects = fixture()
    with patch.object(mapping.RemoteObjectProvider, 'resume_upload', return_value={'upload_id': 'changed'}):
        with pytest.raises(verifier.CheckFailed, match='row-specific'):
            mapping.verify_pending(Client(objects), rows, expected=4)


def reviewed(rows):
    return [{'id': row['id'], 'project_id': row['project_id'], 'sha256': row['content_sha256'],
             'size_bytes': str(row['size_bytes']), 'new_upload_id': row['upload_id']} for row in rows]


@pytest.mark.parametrize('cleared_handle', [False, True])
def test_completed_receipts_are_still_verified_against_the_reviewed_mapping(cleared_handle):
    rows, objects = fixture()
    report_rows = reviewed(rows)
    for row in rows:
        row['status'] = 'available' if row['id'] in {'sto_a', 'sto_b'} else 'uploading'
    if cleared_handle:
        rows[0]['upload_id'] = None
    result = mapping.verify_pending(Client(objects), rows, expected=4, report_rows=report_rows)
    assert result['advanced_research_rows'] == 2
    assert result['unique_handles'] == 4
    assert result['resumed_targets'] == 2


def test_changed_research_identity_cannot_match_an_unrelated_reviewed_row():
    rows, objects = fixture()
    report_rows = reviewed(rows)
    for row in rows:
        row['status'] = 'uploading'
    report_rows[0]['sha256'] = '0' * 64
    with pytest.raises(verifier.CheckFailed, match='reviewed canonical'):
        mapping.verify_pending(Client(objects), rows, expected=4, report_rows=report_rows)


def test_research_query_selects_only_reviewed_ids_under_database_read_only_mode():
    rows, _ = fixture()
    calls = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def execute(self, sql, args):
            calls.append((sql, args))
            return self

        def fetchall(self):
            return rows

    with patch.dict(mapping.os.environ, {'MERV_DB_URL': 'postgresql://unused/test'}), \
            patch.object(mapping, 'verify_schema', return_value=58), \
            patch.object(mapping.psycopg, 'connect', return_value=Connection()) as connect:
        assert mapping.pending_rows(['sto_a', 'sto_b']) == rows
    assert 'default_transaction_read_only=on' in connect.call_args.kwargs['options']
    assert len(calls) == 1 and 'WHERE id=ANY(%s)' in calls[0][0]
    assert calls[0][1] == (['sto_a', 'sto_b'],)
