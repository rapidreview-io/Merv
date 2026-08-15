import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commandGist, commandStatus, fleetActivity, gpuCount, gpuLabel, gpuVramGb, hardwareLabel,
  providerLabel, usageBars, usageLead, usageTrend,
} from './fleet.js';

const NOW = Date.parse('2026-08-01T12:00:00Z');
const running = (extra = {}) => ({ status: 'running', ...extra });
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

test('a command in flight reads as work, with its elapsed time', () => {
  const activity = fleetActivity(
    running({ last_command: { status: 'running', started_at: ago(8) } }),
    NOW,
  );
  assert.equal(activity.tone, 'work');
  assert.equal(activity.label, 'running');
  assert.equal(activity.detail, '8m');
});

test('a quiet box surfaces how long it has been burning money', () => {
  const activity = fleetActivity(
    running({
      last_command: { status: 'finished', exit_code: 0 },
      heartbeat: { idle_since: ago(22) },
    }),
    NOW,
  );
  assert.equal(activity.tone, 'idle');
  assert.equal(activity.label, 'idle 22m');
  assert.equal(activity.detail, 'exit 0');
});

test('a failure outranks idle so the alarm colour wins, keeping both facts', () => {
  const activity = fleetActivity(
    running({
      last_command: { status: 'finished', exit_code: 1 },
      heartbeat: { idle_since: ago(22) },
    }),
    NOW,
  );
  assert.equal(activity.tone, 'fail');
  assert.equal(activity.detail, 'exit 1');
});

test('a running command is never reported as idle', () => {
  const activity = fleetActivity(
    running({
      last_command: { status: 'running', started_at: ago(2) },
      heartbeat: { idle_since: ago(30) },
    }),
    NOW,
  );
  assert.equal(activity.tone, 'work');
});

test('a fresh box says so rather than implying a finished run', () => {
  // The projection always sends `heartbeat` for a running row, even empty.
  assert.equal(fleetActivity(running({ heartbeat: null }), NOW).label, 'no commands yet');
});

test('a row from a backend without the projection claims nothing at all', () => {
  // The UI ships separately from the control plane. Absent keys mean "this
  // server cannot tell me", which must not render as "this box is idle".
  assert.equal(fleetActivity(running(), NOW), null);
  assert.equal(fleetActivity({ status: 'terminated' }, NOW), null);
});

test('a terminated row keeps its verdict and claims no liveness', () => {
  const activity = fleetActivity(
    { status: 'terminated', last_command: { status: 'finished', exit_code: 137 } },
    NOW,
  );
  assert.equal(activity.tone, 'quiet');
  assert.equal(activity.detail, 'exit 137');
  assert.equal(fleetActivity({ status: 'terminated' }, NOW), null);
});

test('bars always read CPU, RAM, GPU, VRAM — a cpu-only box just stops at RAM', () => {
  assert.deepEqual(
    usageBars({ gpu: 94, vram: 61, cpu: 50, mem: 38 }).map(b => b.label),
    ['CPU', 'RAM', 'GPU', 'VRAM'],
  );
  assert.deepEqual(
    usageBars({ gpu: null, vram: null, cpu: 50, mem: 38 }).map(b => b.label),
    ['CPU', 'RAM'],
  );
});

test('each bar keeps its slot so the same metric aligns down the table', () => {
  // RAM alone still sits in slot 1, leaving CPU's slot 0 blank rather than
  // sliding left to fill it.
  assert.deepEqual(
    usageBars({ gpu: 20, mem: 12 }).map(b => [b.label, b.slot]),
    [['RAM', 1], ['GPU', 2]],
  );
});

test('an unreadable metric is omitted rather than drawn at zero', () => {
  // A zero bar would read as an idle box and could talk someone into
  // releasing live work.
  assert.deepEqual(usageBars({ gpu: null, cpu: null, mem: 12 }).map(b => b.label), ['RAM']);
  assert.deepEqual(usageBars(null), []);
});

test('the trend follows the GPU when there is one, else the first bar', () => {
  assert.equal(usageLead(usageBars({ cpu: 50, mem: 38, gpu: 94, vram: 61 })).key, 'gpu');
  assert.equal(usageLead(usageBars({ cpu: 50, mem: 38 })).key, 'cpu');
  assert.equal(usageLead(usageBars({ mem: 38 })).key, 'mem');
  assert.equal(usageLead([]), null);
  assert.equal(usageLead(null), null);
});

test('providers read by name, and an unknown id still says something', () => {
  assert.equal(providerLabel('lambda_labs'), 'Lambda Labs');
  assert.equal(providerLabel('aws'), 'AWS');
  assert.equal(providerLabel('some_new_cloud'), 'some new cloud');
  assert.equal(providerLabel(''), '');
  assert.equal(providerLabel(null), '');
});

test('the command gist drops the cd hops and folds a script onto one line', () => {
  assert.equal(
    commandGist('cd /workspace/sandbox-0bde93a7b951/variant && find results -maxdepth 2'),
    'find results -maxdepth 2',
  );
  assert.equal(
    commandGist("cd '/w s' && cd sub; merv_run audit_v2 -- python3 run.py"),
    'merv_run audit_v2 -- python3 run.py',
  );
  assert.equal(commandGist('  printf "MASKS=";\n  find /data\t-name x  '), 'printf "MASKS="; find /data -name x');
  // A bare cd is a real command; keep it rather than showing nothing.
  assert.equal(commandGist('cd /workspace'), 'cd /workspace');
  assert.equal(commandGist(''), '');
  assert.equal(commandGist(null), '');
});

test('the hardware line names what the row has and nothing else', () => {
  assert.equal(hardwareLabel({ gpu: 'A10', cpu: 30, memory: 204800 }), 'A10 · 24 GB VRAM · 30 cpu · 200 GiB RAM');
  assert.equal(hardwareLabel({ cpu: 4, memory: 16384 }), '4 cpu · 16 GiB RAM');
  assert.equal(hardwareLabel({}), '');
  assert.equal(hardwareLabel(null), '');
});

test('VRAM comes from the box first, then the label, then only single-config cards', () => {
  // The live sample wins even over the label.
  assert.equal(gpuVramGb({ gpu: 'A100', heartbeat: { gpus: { count: 1, vram_mib: 81920 } } }), 80);
  assert.equal(gpuVramGb({ gpu: 'A100 40GB' }), 40);
  assert.equal(gpuVramGb({ gpu: 'RTX 4090' }), 24);
  assert.equal(gpuVramGb({ gpu: 'L40S' }), 48);
  // A100 / H100 / V100 ship in more than one size: never guess.
  assert.equal(gpuVramGb({ gpu: 'A100' }), null);
  assert.equal(gpuVramGb({ gpu: 'H100' }), null);
  assert.equal(gpuVramGb({}), null);
});

test('card count reads from the sample or a Lambda-style SKU, else stays unknown', () => {
  assert.equal(gpuCount({ heartbeat: { gpus: { count: 8, vram_mib: 81920 } } }), 8);
  assert.equal(gpuCount({ instance_type: 'gpu_8x_h100_sxm5' }), 8);
  assert.equal(gpuCount({ instance_type: 'gpu_1x_a10' }), 1);
  assert.equal(gpuCount({ instance_type: 'g5.2xlarge' }), null);
  assert.equal(gpuCount({}), null);
});

test('the GPU phrase composes count, model and VRAM without repeating a size', () => {
  assert.equal(
    gpuLabel({ gpu: 'H100', instance_type: 'gpu_8x_h100_sxm5', heartbeat: { gpus: { count: 8, vram_mib: 81920 } } }),
    '8× H100 · 80 GB VRAM',
  );
  assert.equal(gpuLabel({ gpu: 'A100 80GB' }), 'A100 · 80 GB VRAM');
  assert.equal(gpuLabel({ gpu: 'A100' }), 'A100');
  assert.equal(gpuLabel({ gpu: 'A10G', instance_type: 'g5.2xlarge' }), 'A10G · 24 GB VRAM');
  assert.equal(gpuLabel({}), '');
});

test('the command status says what the last command is doing and how long ago it finished', () => {
  const work = running({ last_command: { status: 'running', started_at: ago(8) } });
  assert.equal(commandStatus(work, fleetActivity(work, NOW), NOW), 'running · 8m');

  const idle = running({
    last_command: { status: 'finished', exit_code: 0, finished_at: ago(22) },
    heartbeat: { idle_since: ago(22) },
  });
  assert.equal(commandStatus(idle, fleetActivity(idle, NOW), NOW), 'idle 22m · exit 0');

  const failed = running({
    last_command: { status: 'finished', exit_code: 1, finished_at: ago(11) },
    heartbeat: { idle_since: ago(11) },
  });
  assert.equal(commandStatus(failed, fleetActivity(failed, NOW), NOW), 'failed · exit 1 · 11m ago');

  const done = { status: 'terminated', last_command: { status: 'finished', exit_code: 0, finished_at: ago(185) } };
  assert.equal(commandStatus(done, fleetActivity(done, NOW), NOW), 'exit 0 · 3h 5m ago');

  const fresh = running({ heartbeat: null });
  assert.equal(commandStatus(fresh, fleetActivity(fresh, NOW), NOW), 'no commands yet');
  assert.equal(commandStatus(fresh, null, NOW), '');
});

test('the trend tracks one named metric and drops gaps', () => {
  const series = [{ gpu: 10 }, { gpu: null }, { gpu: 90 }, {}];
  assert.deepEqual(usageTrend(series, 'gpu'), [10, 90]);
  assert.deepEqual(usageTrend(series, undefined), []);
  assert.deepEqual(usageTrend(null, 'gpu'), []);
});
