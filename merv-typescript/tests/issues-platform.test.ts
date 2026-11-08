import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createService, type Caller } from '@merv/contracts';
import type { IssueReport, Issues } from '@merv/contracts/issues';

import type { FleetOwner } from '@merv/fleet/types';

import { ProjectScope } from '@merv/scope';

import { FleetService } from '../packages/fleet/src/index.js';

import { profiles } from './fixtures/runtime-records.js';
import { FakeRuntimes } from './fixtures/runtimes.js';
import { openState } from './fixtures/state.js';

/** An owner's issues as a list: what it reported, in order. */
function capture() {
  const reports: IssueReport[] = [];
  const issues: Issues = { report: (issue) => void reports.push(issue), resolve() {} };
  const at = (where: string) => reports.filter((issue) => issue.where === where);
  return { reports, issues, at };
}

async function fleetFixture(t: TestContext, owner: Partial<FleetOwner> = {}) {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const admin = await scope.credentials.bootstrap({ projectName: 'Fleet', actorName: 'Operator' });
  const caller: Caller = {
    projectId: admin.project.id,
    actorId: admin.actor.id,
    credentialId: admin.credential.id,
  };
  const runtimes = new FakeRuntimes();
  let now = Date.parse('2026-09-22T00:00:00Z');
  const fleet = await createService(
    new FleetService(state, scope, runtimes, { profiles }, () => now),
  );
  const seen = capture();
  fleet.issues = seen.issues;
  fleet.registerOwner('workflow', {
    valid: async () => true,
    bootstrap: async () => 'bootstrap',
    observe: async () => 'running',
    ...owner,
  });
  t.after(async () => {
    await fleet.close();
    await state.close();
  });
  const allocation = await fleet.request(caller, {
    requestId: 'r1',
    owner: { kind: 'workflow', id: 'work:wf_1' },
  });
  const machine = () => [...runtimes.handles.values()][0]!;
  return {
    ...seen,
    caller,
    runtimes,
    fleet,
    allocation,
    machine,
    advance: (ms: number) => void (now += ms),
  };
}

test('a machine the provider stopped while its work ran is reported gone, once', async (t) => {
  const f = await fleetFixture(t);
  for (const _ of [1, 2, 3]) await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, f.allocation.id)).phase, 'running');
  f.runtimes.release(f.machine().sandboxId);
  await f.fleet.tick();
  await f.fleet.tick();
  assert.deepEqual(
    f.at('fleet.machine_gone').map((issue) => [issue.code, issue.level, issue.subject]),
    [['stopped', 'severe', f.allocation.id]],
  );
  const [gone] = f.at('fleet.machine_gone');
  assert.equal(gone!.refs?.sandboxId, f.machine().sandboxId);
  assert.equal(gone!.refs?.instanceId, 'wf_1');
  assert.equal(gone!.refs?.runtimeRelease, profiles[0]!.releaseId);
});
