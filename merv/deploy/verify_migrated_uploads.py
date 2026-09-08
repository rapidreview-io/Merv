#!/usr/bin/env python3
"""Verify migrated pending receipt identities without transferring any bytes.

Research queries use a database-enforced read-only session. Native metadata is
read for every distinct target; only one available target and the smallest
uploading target are resumed. Existing migration sessions are never completed
or deleted. Reports never contain upload handles or signed transfer URLs.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import sys
from typing import Any

import psycopg
from psycopg.rows import dict_row

from merv.brain.infrastructure.client import build_infrastructure_client
from merv.brain.infrastructure.ports import project_namespace
from merv.brain.infrastructure.storage import RemoteObjectProvider, _decode_upload
from verify_sandboxes_cutover import emit, require, safe_failure, verify_schema


def pending_rows(ids: list[str]) -> list[dict[str, Any]]:
    require(bool(os.environ.get('MERV_DB_URL')), 'MERV_DB_URL is required')
    with psycopg.connect(os.environ['MERV_DB_URL'], row_factory=dict_row,
                        options='-c default_transaction_read_only=on -c statement_timeout=30000') as conn:
        require(verify_schema(conn) == 58, 'final schema58 is required')
        return conn.execute('''SELECT id,project_id,namespace,content_sha256,size_bytes,upload_id,status
            FROM storage_objects WHERE id=ANY(%s) ORDER BY project_id,id''', (ids,)).fetchall()


def row_identity(row: dict[str, Any]) -> tuple[str, str]:
    handle = row['upload_id']
    namespace, object_id = _decode_upload(handle)
    raw = handle[5:]
    identity = json.loads(base64.urlsafe_b64decode(raw + '=' * (-len(raw) % 4)))
    require(len(identity) == 3 and identity[2] == row['id'], 'migrated upload handle does not identify its own research row')
    require(namespace == row['project_id'] == row['namespace'], 'migrated upload namespace differs from its project')
    return project_namespace(namespace), object_id


def verify_pending(client: Any, rows: list[dict[str, Any]], *, expected: int = 120,
                   report_rows: list[dict[str, Any]] | None = None) -> dict[str, int]:
    require(len(rows) == expected, 'pending receipt count differs from the reviewed mapping')
    require(len({row['id'] for row in rows}) == len(rows), 'duplicate research row identity')
    rows = [dict(row) for row in rows]
    advanced_rows = 0
    if report_rows is not None:
        expected_rows = {row['id']: row for row in report_rows}
        require(len(expected_rows) == len(report_rows) == expected, 'reviewed mapping row identities are not unique')
        require(set(expected_rows) == {row['id'] for row in rows}, 'research rows differ from the reviewed mapping IDs')
        for row in rows:
            reviewed = expected_rows[row['id']]
            require(row['status'] in {'uploading', 'completing', 'available'}, 'migrated receipt is no longer an active or completed upload')
            require(row['project_id'] == reviewed['project_id'] and row['content_sha256'] == reviewed['sha256']
                    and row['size_bytes'] == int(reviewed.get('canonical_size_bytes', reviewed['size_bytes'])),
                    'research receipt differs from the reviewed canonical identity')
            if row['status'] != 'uploading':
                advanced_rows += 1
            # Current completion preserves the handle. A future completion
            # path may clear it; only a completed row may use the report's
            # immutable identity to verify its already-available native target.
            if not row['upload_id']:
                require(row['status'] == 'available', 'pending receipt lost its migrated completion handle')
                row['upload_id'] = reviewed['new_upload_id']
            require(row['upload_id'] == reviewed['new_upload_id'], 'research upload handle differs from the reviewed mapping')
    require(len({row['upload_id'] for row in rows}) == len(rows), 'migrated upload handles are not unique')
    metadata: dict[tuple[str, str], dict[str, Any]] = {}
    representatives: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        namespace, object_id = row_identity(row)
        key = namespace, object_id
        if key not in metadata:
            metadata[key] = client.request('GET', '/storage/objects/' + object_id, namespace=namespace)
            representatives[key] = row
        native = metadata[key]
        require(native['id'] == object_id and native['namespace'] == namespace, 'native receipt identity or namespace mismatch')
        require(native['sha256'] == row['content_sha256'] and native['size_bytes'] == row['size_bytes'], 'pending receipt metadata differs from its canonical native object')
        require(native['name'] == row['content_sha256'], 'native content name differs from the receipt digest')
        require(native['state'] in {'available', 'uploading', 'completing'}, 'migrated receipt target is no longer usable')
        if row.get('status') == 'available':
            require(native['state'] == 'available', 'completed research receipt has no available canonical native bytes')
    provider = RemoteObjectProvider(client=client)
    selected: list[tuple[tuple[str, str], dict[str, Any]]] = []
    for state in ('available', 'uploading'):
        candidates = [(key, row) for key, row in representatives.items() if metadata[key]['state'] == state]
        if candidates:
            selected.append(min(candidates, key=lambda pair: (pair[1]['size_bytes'], pair[1]['id'])))
    for (namespace, object_id), row in selected:
        target = provider.resume_upload(upload_id=row['upload_id'], expires_in=300)
        require(target['upload_id'] == row['upload_id'], 'resuming changed the row-specific completion handle')
        require(target['size_bytes'] == row['size_bytes'], 'resuming changed the canonical byte size')
        require(target['checksum_sha256'] == base64.b64encode(bytes.fromhex(row['content_sha256'])).decode(), 'resuming changed the canonical digest')
        emit('migrated_upload_resume', ok=True, row_id=row['id'], native_object_id=object_id,
             namespace=namespace, state=metadata[namespace, object_id]['state'],
             size_bytes=row['size_bytes'], part_count=target['part_count'], handle_preserved=True)
    result = {'pending_rows': len(rows), 'unique_handles': len(rows), 'native_objects': len(metadata),
              'resumed_targets': len(selected), 'transferred_bytes': 0}
    if report_rows is not None:
        result['advanced_research_rows'] = advanced_rows
    emit('migrated_upload_mapping', ok=True, **result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected', type=int, default=120)
    parser.add_argument('--report', required=True, help='successful applied migration report path, or - to read it from stdin')
    args = parser.parse_args()
    client = None
    try:
        require(1 <= args.expected <= 1000, 'expected receipt count outside bound')
        report = json.load(sys.stdin) if args.report == '-' else json.loads(Path(args.report).read_text())
        require(report.get('applied') is True and not report.get('failures'), 'a successful applied migration report is required')
        reviewed = report['upload_id_mapping']
        require(len(reviewed) == args.expected, 'reviewed mapping count differs from expectation')
        rows = pending_rows([row['id'] for row in reviewed])
        client = build_infrastructure_client()
        require(client is not None, 'native service configuration is missing')
        verify_pending(client, rows, expected=args.expected, report_rows=reviewed)
        return 0
    except Exception as exc:
        emit('failed', ok=False, **safe_failure(exc))
        return 1
    finally:
        if client is not None:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
