import { existsSync } from 'node:fs';
import { FleetService } from '../../packages/fleet/src/index.js';
import { PiService } from '../../packages/pi/src/service.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MervError, type Scope } from '@merv/contracts';
import { ApiServer } from '../../packages/api/src/http.js';
import { ToolRegistry } from '../../packages/api/src/registry.js';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { PiHosts } from '../../packages/pi/src/hosts.js';
import { FleetWorkflowAdapter } from '../../packages/fleet/src/workflow.js';
import { CustomerService } from '../../packages/customer-experiments/src/service.js';
import { FilesService } from '../../packages/customer-experiments/src/files.js';
import { CodeStore } from '../../packages/code/src/store/operations.js';
import { MainLanding } from '../../packages/code-work/src/landing.js';
import { CodeBaseService } from '../../packages/code-work/src/bases.js';
import { SandboxRuns } from '../../packages/sandboxes/src/sandbox-runs.js';
import { SandboxEvidence } from '../../packages/sandboxes/src/sandbox-evidence.js';
import { wakeAutomatic } from '../../packages/research/src/automatic.js';

test('paused schedulers never reach storage, provider calls or service state', async () => {
  // Access to any dependency fails; these are the real methods used at boot and on timers.
  const untouched = new Proxy(
    {},
    {
      get(_target, key) {
        throw Error(`Touched dependency ${String(key)}`);
      },
    },
  );
  const entries: [object, string][] = [
    [FleetService.prototype, 'run'],
    [FleetService.prototype, 'wake'],
    [DurableEvents.prototype, 'drain'],
    [LeasedSessions.prototype, 'pass'],
    [PiHosts.prototype, 'tick'],
    [FleetWorkflowAdapter.prototype, 'reconcile'],
    [CustomerService.prototype, 'reconcile'],
    [FilesService.prototype, 'sweep'],
    [CodeStore.prototype, 'maintain'],
    [MainLanding.prototype, 'tick'],
    [MainLanding.prototype, 'soon'],
    [CodeBaseService.prototype, 'start'],
    [CodeBaseService.prototype, 'soon'],
    [SandboxRuns.prototype, 'reconcile'],
    [SandboxEvidence.prototype, 'reconcile'],
  ];
  for (const [prototype, name] of entries) await (prototype as any)[name].call(untouched);
  await wakeAutomatic(untouched as any);
  // The migration branch adds this scheduler. Combined-release testing must prove its
  // companion patch is present, without requiring that unmerged file on the base branch.
  const native = new URL('../../packages/code-work/src/submissions.ts', import.meta.url);
  if (existsSync(native)) {
    const { CodeSubmissionService } = await import(native.href);
    for (const name of ['start', 'wake', 'reconcile'])
      await CodeSubmissionService.prototype[name].call(untouched);
  }
  const fleet = Object.assign(Object.create(FleetService.prototype), {
    state: untouched,
    owners: new Map(),
  });
  await fleet.close();
  assert.equal(fleet.closed, true);
  const pi = Object.assign(Object.create(PiService.prototype), {
    core: { closed: false, state: untouched, streams: { close() {} } },
    hosts: {},
    disposers: [],
    asks: new Map(),
  });
  await pi.close();
  assert.equal(pi.core.closed, true);
});

test('HTTP health/static remain usable; operator capability never replaces normal auth', async () => {
  let effects = 0;
  const scope = {
    async authenticate(token: string) {
      if (token !== 'valid') throw new MervError('unauthorized', 'Invalid token', 401);
      return { id: 'operator' };
    },
  } as unknown as Scope;
  const api = new ApiServer(scope, new ToolRegistry(scope));
  api.mount('/probe', () => {
    effects++;
    return { ok: true };
  });
  api.mount('/denied', () => {
    throw new MervError('forbidden', 'Forbidden', 403);
  });
  api.mount(
    '/payments',
    () => {
      effects++;
      return { ok: true };
    },
    { public: true },
  );
  api.mount('/ui', () => 'static', { public: true });
  const url = await api.start();
  const operator = {
    authorization: 'Bearer valid',
    'x-merv-maintenance-operator': process.env.MERV_MAINTENANCE_OPERATOR_TOKEN!,
  };
  try {
    const health = await fetch(`${url}/health`);
    assert.deepEqual(await health.json(), { status: 'ok', maintenance: true });
    assert.equal((await fetch(`${url}/ui/assets/app.js`)).status, 200);
    assert.equal((await fetch(`${url}/ui/`)).status, 200);
    assert.equal((await fetch(`${url}/ui/settings`)).status, 503);
    assert.equal((await fetch(`${url}/probe`)).status, 401);
    assert.equal(
      (await fetch(`${url}/probe`, { headers: { authorization: 'Bearer valid' } })).status,
      503,
    );
    assert.equal(
      (await fetch(`${url}/probe`, { headers: { ...operator, authorization: 'Bearer invalid' } }))
        .status,
      401,
    );
    assert.equal((await fetch(`${url}/probe`, { headers: operator })).status, 200);
    assert.equal((await fetch(`${url}/denied`, { headers: operator })).status, 403);
    for (const path of ['/payments/stripe', '/payments/webhook'])
      assert.equal((await fetch(`${url}${path}`, { method: 'POST' })).status, 503);
    assert.equal(effects, 1);
  } finally {
    await api.stop();
  }
});
