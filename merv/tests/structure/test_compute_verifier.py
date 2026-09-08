"""Exercise the reviewed smoke flow without purchasing or contacting compute."""
from copy import deepcopy
from datetime import datetime, timezone, timedelta
import importlib.util
import io
import logging
import os
from pathlib import Path
import sys
from unittest.mock import patch

import pytest

from tests.structure.test_sandboxes_verifier import verifier
from tests.support.infrastructure import FakeInfrastructureClient


class NativeSmoke(FakeInfrastructureClient):
    def __init__(self, *, lost_create=False):
        super().__init__()
        self.offer.update(provider='lambda', plugin='lambda', offer_id='gpu_1x_a10:us-east-1', instance_type='gpu_1x_a10')
        self.offer['hourly_price']['amount'] = '1.29'
        self.offer['resources'].update(gpu_count=1, gpu='A10')
        self.snapshots = {}
        self.lost_create = lost_create

    def request(self, method, path, *, namespace, json=None, params=None, budget=None):
        if path == '/providers':
            self.providers[namespace] = {'lambda': {'name': 'lambda', 'plugin': 'lambda', 'source': 'host', 'health': {'status': 'ok'}}}
        if path == '/spend/budget':
            return json
        if path.startswith('/access/certificates/'):
            return {}
        if path == '/spend':
            return {'month_to_date': [{'currency': 'USD', 'amount': '0.01'}]}
        if path == '/snapshots':
            return {'snapshots': deepcopy(list(self.snapshots.get(namespace, {}).values()))}
        if path.startswith('/snapshots/'):
            oid = path.rsplit('/', 1)[1]
            if oid not in self.snapshots.get(namespace, {}):
                raise verifier.NotFoundError('not found')
            if method == 'DELETE':
                self.snapshots[namespace][oid]['state'] = 'deleted'
            return deepcopy(self.snapshots[namespace][oid])
        result = super().request(method, path, namespace=namespace, json=json, params=params, budget=budget)
        if path == '/sandboxes' and method == 'POST':
            self.records[namespace][result['id']]['lease_expires_at'] = (datetime.now(timezone.utc) + timedelta(seconds=600)).isoformat()
            result = deepcopy(self.records[namespace][result['id']])
            if self.lost_create:
                raise RuntimeError('accepted create response was lost')
        if path == '/access/certificates':
            result['serial'] = 1
        if path.startswith('/sandboxes/') and path.endswith('/jobs'):
            self.jobs[namespace][result['id']].update(state='succeeded', exit_code=0, artifact_id='snap_smoke')
            result = deepcopy(self.jobs[namespace][result['id']])
            self.snapshots[namespace] = {'snap_smoke': {'id': 'snap_smoke', 'state': 'ready', 'manifest_id': 'manifest_smoke', 'files': 1, 'bytes': len(b'merv-job-smoke\n')}}
        return result

    def request_bytes(self, method, path, *, namespace, params=None):
        return (b'merv-job-smoke\n' if params['stream'] == 'stdout' else b'merv-job-stderr\n', {'x-output-complete': '1'})


def smoke_module():
    spec = importlib.util.spec_from_file_location('compute_verifier', Path(__file__).resolve().parents[2] / 'deploy' / 'verify_merv_compute.py')
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {'verify_sandboxes_cutover': verifier}), patch.dict(os.environ):
        spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize('lost_create', [False, True])
def test_compute_cleanup_and_no_provisioning_retry(lost_create):
    logging_disabled_before = logging.root.manager.disable
    module = smoke_module()
    native = NativeSmoke(lost_create=lost_create)
    public = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZm test'
    with patch.dict(os.environ, {'MERV_SMOKE_PUBLIC_KEY': public, 'MERV_DB_URL': '', 'RESEARCH_PLUGIN_DB_URL': ''}, clear=True), \
            patch.dict(module.build_control_app.__globals__, {'build_infrastructure_client': lambda *args: native}), \
            patch.object(module.sys, 'stdin', io.StringIO('{"ssh_ok": true}\n')):
        if lost_create:
            with pytest.raises(RuntimeError, match='response was lost'):
                module.run()
        else:
            module.run()
    creates = [call for call in native.calls if call[:2] == ('POST', '/sandboxes')]
    assert len(creates) == 1
    assert all(row['state'] == 'stopped' for records in native.records.values() for row in records.values())
    assert all(row['state'] == 'deleted' for rows in native.snapshots.values() for row in rows.values())
    assert creates[0][3]['merv_budget']['project_daily_usd_limit'] == '1.0'
    assert creates[0][3]['merv_budget']['provider_daily_usd_limit'] == '1.0'
    assert logging.root.manager.disable == logging_disabled_before
