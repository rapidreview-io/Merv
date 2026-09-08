"""One reviewed Lambda lifecycle, through Merv facades and native access."""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import sys
import tempfile
import time
from datetime import datetime, timezone
from decimal import Decimal

os.environ['MERV_DB_URL'] = ''
os.environ['RESEARCH_PLUGIN_DB_URL'] = ''
from verify_sandboxes_cutover import emit, require, safe_failure
from merv.brain.infrastructure.ports import project_namespace
from merv.brain.kernel.utils import NotFoundError
from merv.brain.surface.surface import build_control_app

PROVIDER = 'lambda'
LEGACY_PROVIDER = 'lambda_labs'
OFFER = 'gpu_1x_a10:us-east-1'
PRICE = Decimal('1.29')
TERMINAL = {'succeeded', 'failed', 'cancelled', 'timed_out'}


def absent(client, path, namespace):
    try:
        client.request('GET', path, namespace=namespace)
    except NotFoundError:
        return
    raise RuntimeError('foreign namespace obtained smoke resource')


def run() -> None:
    with tempfile.TemporaryDirectory(prefix='merv-compute-smoke-') as temporary:
        app = build_control_app(repo_root=Path(temporary), env=dict(os.environ))
        project = app.research.create_project(name='Temporary compute smoke', user_id='smoke-payer')
        pid = project['id']
        namespace = project_namespace(pid)
        client = app.infrastructure_client
        sandbox_id = None
        job_id = None
        certificate_serial = None
        job_succeeded = False
        stopped = False
        cleanup_errors = []
        created_at = None
        try:
            require(app._store.db_path.is_relative_to(Path(temporary)), 'compute research state must remain temporary')
            # The native admission receives both limits through the real Merv
            # daily_budget derivation, signed by its configured HTTP client.
            with app._store.transaction() as conn:
                conn.execute('INSERT INTO sandbox_provider_settings(project_id,provider,daily_usd_limit,updated_at) VALUES(?,?,?,?)', (pid, LEGACY_PROVIDER, 1, datetime.now(timezone.utc).isoformat()))
                conn.execute('INSERT INTO provider_user_caps(provider,user_id,daily_usd_limit,updated_at) VALUES(?,?,?,?)', (LEGACY_PROVIDER, 'smoke-' + pid, 1, datetime.now(timezone.utc).isoformat()))
            client.request('PUT', '/spend/budget', namespace=namespace,
                           json={'monthly_cap': '1', 'currency': 'USD', 'max_lease_seconds': 900})
            offers = client.request('GET', '/options', namespace=namespace,
                                   params={'provider': PROVIDER, 'all_options': 'true', 'refresh': 'true'})['offers']
            offer = next(row for row in offers if row['offer_id'] == OFFER)
            require(offer['available'] and offer['resources']['gpu_count'] == 1, 'approved single-GPU offer is unavailable')
            require(offer['hourly_price']['currency'] == 'USD' and Decimal(offer['hourly_price']['amount']) <= PRICE, 'offer price increased beyond approval')
            emit('compute_intent', namespace=namespace, provider=PROVIDER, offer_id=OFFER,
                 initial_lease_seconds=600, maximum_total_lease_seconds=900, total_budget_usd='1',
                 hourly_usd='1.29', conservative_sixteen_billed_minutes_usd='0.344',
                 billing_source='https://docs.lambda.ai/public-cloud/billing/')
            created_at = time.monotonic()
            facts = app.sandboxes.request(project_id=pid, provider=PROVIDER, instance_type=OFFER,
                    time_limit=600, public_key=os.environ['MERV_SMOKE_PUBLIC_KEY'], provisioning_user_id='smoke-' + pid)
            sandbox_id = facts['sandbox_uid']
            emit('compute_created', sandbox_id=sandbox_id, namespace=namespace)
            ready_deadline = created_at + 480
            while time.monotonic() < ready_deadline:
                record = client.request('GET', '/sandboxes/' + sandbox_id, namespace=namespace, params={'wait': 10})
                if record['state'] == 'ready':
                    break
                require(record['state'] == 'provisioning', 'smoke provisioning failed or became uncertain')
                time.sleep(2)
            require(record['state'] == 'ready', 'smoke readiness deadline exceeded')
            claims = record['request']['merv_budget']
            require(Decimal(claims['project_daily_usd_limit']) == Decimal(1) and Decimal(claims['provider_daily_usd_limit']) == Decimal(1), 'native signed daily limits were not preserved')
            original_expiry = datetime.fromisoformat(record['lease_expires_at'])
            emit('compute_ready', sandbox_id=sandbox_id, namespace=namespace, seconds=round(time.monotonic() - created_at, 2))
            facts = app.sandboxes.get(project_id=pid, sandbox_uid=sandbox_id)
            require(facts['status'] == 'running' and facts['ssh']['host_public_key'], 'Merv caller SSH projection failed')
            access = client.request('POST', '/access/certificates', namespace=namespace,
                     json={'public_key': os.environ['MERV_SMOKE_PUBLIC_KEY'], 'sandbox_id': sandbox_id, 'ttl_seconds': 60})
            certificate_serial = access['serial']
            print(json.dumps({'bridge': 'ssh', 'sandbox_id': sandbox_id, 'certificate': access['certificate'], 'gateway': access['gateway']}), flush=True)
            response = json.loads(sys.stdin.readline())
            require(response == {'ssh_ok': True}, 'strict host-key-pinned caller SSH failed')
            emit('compute_ssh', ok=True, sandbox_id=sandbox_id, certificate_seconds=60)
            command = "mkdir -p /workspace/merv-smoke-output\nprintf 'merv-job-smoke\\n' > /workspace/merv-smoke-output/result.txt\nprintf 'merv-job-smoke\\n'\nprintf 'merv-job-stderr\\n' >&2\n"
            job = app.sandboxes.run(project_id=pid, sandbox_uid=sandbox_id, name='merv-smoke-job', command=command,
                      cwd='/workspace', timeout_seconds=30, outputs='/workspace/merv-smoke-output', idempotency_key='smoke-job-' + pid)
            job_id = job['id']
            emit('compute_job_started', sandbox_id=sandbox_id, job_id=job_id)
            deadline = min(created_at + 570, time.monotonic() + 150)
            while job['state'] not in TERMINAL and time.monotonic() < deadline:
                job = app.sandboxes.job(project_id=pid, job_id=job_id, after=job.get('cursor'), wait_seconds=10)
            require(job['state'] == 'succeeded' and job['exit_code'] == 0, 'durable smoke job failed or timed out')
            for stream, marker in [('stdout', 'merv-job-smoke\n'), ('stderr', 'merv-job-stderr\n')]:
                output = app.sandboxes.job(project_id=pid, job_id=job_id, stream=stream, limit=1024)['output']
                require(output['text'] == marker and output['complete'] and not output['truncated'], 'durable job output mismatch')
            job_succeeded = True
            # Artifact capture completes asynchronously after the command.
            while not job.get('artifact_id') and time.monotonic() < deadline:
                job = app.sandboxes.job(project_id=pid, job_id=job_id, after=job.get('cursor'), wait_seconds=5)
            require(bool(job.get('artifact_id')), 'durable outputs snapshot was not retained')
            snapshot = client.request('GET', '/snapshots/' + job['artifact_id'], namespace=namespace)
            while snapshot['state'] == 'pending' and time.monotonic() < deadline:
                time.sleep(2)
                snapshot = client.request('GET', '/snapshots/' + job['artifact_id'], namespace=namespace)
            require(snapshot['state'] == 'ready' and snapshot['manifest_id'] and snapshot['files'] == 1 and snapshot['bytes'] == len(b'merv-job-smoke\n'), 'output snapshot manifest does not match the retained file')
            wrong = 'merv-project-smoke-denied'
            for path in ['/sandboxes/' + sandbox_id, '/jobs/' + job_id, '/jobs/' + job_id + '/output', '/snapshots/' + job['artifact_id']]:
                absent(client, path, wrong)
            emit('compute_job', ok=True, job_id=job_id, snapshot_id=job['artifact_id'], snapshot_files=snapshot['files'], snapshot_bytes=snapshot['bytes'], namespace_isolation=True)
            require(time.monotonic() - created_at < 580, 'smoke exceeded renewal readiness bound')
            renewed = app.sandboxes.extend(project_id=pid, sandbox_uid=sandbox_id, seconds=300)
            renewed_expiry = datetime.fromisoformat(renewed['expires_at'])
            require(299 <= (renewed_expiry - original_expiry).total_seconds() <= 302, 'Merv additive renewal did not advance by300seconds')
            emit('compute_renewal', ok=True, sandbox_id=sandbox_id, extended_seconds=round((renewed_expiry - original_expiry).total_seconds()))
        finally:
            # Namespace is unique to this temporary synthetic project. Recover
            # an accepted create whose HTTP response was lost, then delete it.
            try:
                records = client.request('GET', '/sandboxes', namespace=namespace, params={'include_stopped': 'true'})['sandboxes']
                for row in records:
                    if row['state'] != 'stopped':
                        app.sandboxes.release(project_id=pid, sandbox_uid=row['id'], confirm_retained=True)
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    records = client.request('GET', '/sandboxes', namespace=namespace, params={'include_stopped': 'true'})['sandboxes']
                    if all(row['state'] == 'stopped' for row in records):
                        stopped = True
                        break
                    time.sleep(3)
                emit('compute_release', ok=stopped, namespace=namespace,
                     sandboxes=[{'id': row['id'], 'state': row['state'], 'cost_so_far': row.get('cost_so_far')} for row in records])
                if job_id and stopped and job_succeeded:
                    try:
                        retained = app.sandboxes.job(project_id=pid, job_id=job_id, stream='stdout', limit=1024)
                        require(retained['state'] == 'succeeded' and retained['output']['text'] == 'merv-job-smoke\n', 'job output did not survive release')
                    except Exception as exc:
                        cleanup_errors.append(safe_failure(exc))
                snapshots = client.request('GET', '/snapshots', namespace=namespace, params={'include_deleted': 'true'})['snapshots']
                for snapshot in snapshots:
                    if snapshot['state'] != 'deleted':
                        client.request('DELETE', '/snapshots/' + snapshot['id'], namespace=namespace)
                deadline = time.monotonic() + 120
                while snapshots and time.monotonic() < deadline:
                    snapshots = client.request('GET', '/snapshots', namespace=namespace, params={'include_deleted': 'true'})['snapshots']
                    if all(row['state'] == 'deleted' for row in snapshots):
                        break
                    time.sleep(3)
                require(all(row['state'] == 'deleted' for row in snapshots), 'smoke snapshot deletion still pending')
                if certificate_serial is not None:
                    client.request('DELETE', '/access/certificates/' + str(certificate_serial), namespace=namespace)
                spend = client.request('GET', '/spend', namespace=namespace)
                require(all(row['currency'] == 'USD' and Decimal(row['amount']) <= 1 for row in spend['month_to_date']), 'native smoke spend exceeded the approved bound')
                emit('compute_cleanup', ok=stopped, namespace=namespace, snapshot_ids=[row['id'] for row in snapshots], month_to_date=spend['month_to_date'])
            except Exception as exc:
                cleanup_errors.append(safe_failure(exc))
                emit('compute_cleanup', ok=False, namespace=namespace, errors=cleanup_errors)
            finally:
                app.shutdown()
        require(stopped and not cleanup_errors, 'smoke cleanup needs operator attention')
        emit('compute_complete', ok=True, namespace=namespace, sandbox_id=sandbox_id, job_id=job_id)


if __name__ == '__main__':
    logging.disable(logging.CRITICAL)
    try:
        run()
    except Exception as exc:
        emit('compute_failed', ok=False, **safe_failure(exc))
        raise SystemExit(1)
