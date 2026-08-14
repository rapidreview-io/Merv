import assert from 'node:assert/strict';
import test from 'node:test';

import { runnerPresentation } from './runnerPresentation.js';

const machine = {
  hostname: 'Gurals-MBP.local',
  system: 'Darwin',
  architecture: 'arm64',
  runner_id: '0123456789abcdef0123456789abcdef',
};

test('a reachable active runner on this project is live and identified', () => {
  assert.deepEqual(
    runnerPresentation({
      connection: 'connected',
      projectId: 'proj_here',
      status: { runner_active: true, project_id: 'proj_here', machine },
    }),
    {
      active: true,
      machineName: 'Gurals-MBP.local',
      machineDetails: 'macOS · arm64 · runner 012345…bcdef',
      project: 'This project',
      projectMatches: true,
      reachable: true,
      state: 'Live',
      tone: 'live',
    },
  );
});

test('an active runner for another project is not presented as ready', () => {
  const result = runnerPresentation({
    connection: 'connected',
    projectId: 'proj_here',
    status: { runner_active: true, project_id: 'proj_somewhere_else', machine },
  });
  assert.equal(result.state, 'Wrong project');
  assert.equal(result.tone, 'warning');
  assert.equal(result.projectMatches, false);
});

test('a lost loopback connection is offline even if its last status was active', () => {
  const result = runnerPresentation({
    connection: 'unreachable',
    projectId: 'proj_here',
    status: { runner_active: true, project_id: 'proj_here', machine },
  });
  assert.equal(result.state, 'Offline');
  assert.equal(result.active, false);
});
