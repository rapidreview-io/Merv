import type { WorkflowExecutionPolicy } from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'smol-toml';
import { buildLaunch, validateProfile } from '../packages/runner/src/profiles.js';
import { taskExecutionPolicy } from '../packages/tasks/src/execution-policy.js';

function launch(policy: WorkflowExecutionPolicy, cwd = '/workspace/assignments/' + '1'.repeat(64)) {
  const common = {
    instanceId: 'wf_gate',
    projectId: 'project_gate',
    actorId: 'actor_gate',
    revision: 0,
  };
  const session = {
    id: 'session_gate',
    kind: 'work',
    role: 'reviewer',
    status: 'active',
    ...common,
    expectedRevision: 0,
    execution: { ...common, policy, references: {} },
    assignment: { ...common, execution: { readOnly: policy.readOnly } },
  } as unknown as Session;
  const spec = buildLaunch(
    validateProfile({
      name: 'test',
      harness: 'codex',
      executable: '/opt/merv/bin/codex',
      isolatedLauncher: '/opt/merv/runtime/assignment-probed.py',
      hosted: true,
      enabled: true,
      parallelism: 1,
    }),
    {
      session,
      cwd,
      secret: 'ms_' + 'x'.repeat(43),
      prompt: 'Review the submitted code.',
      mcpUrl: 'https://example.invalid/mcp',
    },
    {},
  );
  return { spec, config: parse(spec.args.filter((_, i) => spec.args[i - 1] === '-c').join('\n')) };
}

test('reviewer grants only scratch writes through Codex and retains the kernel mount', () => {
  const policy = taskExecutionPolicy('review', 'code', true, true);
  const { spec, config } = launch(policy);
  assert.equal(spec.executable, '/opt/merv/runtime/assignment-probed.py');
  assert.equal(spec.env.MERV_REVIEW_CODE, '1');
  assert.equal(config.approval_policy, 'never');
  assert.equal(spec.args.includes('--sandbox'), false);
  assert.equal(config.sandbox_workspace_write, undefined);
  assert.equal(config.default_permissions, 'merv-review');
  assert.deepEqual(JSON.parse(JSON.stringify(config.permissions)), {
    'merv-review': {
      extends: ':read-only',
      filesystem: { ':slash_tmp': 'write' },
      network: { enabled: true },
    },
  });
  const shell = config.shell_environment_policy as Record<string, any>;
  assert.equal(shell.inherit, 'none');
  assert.equal(shell.set.UV_CACHE_DIR, '/tmp/cache/uv');
  assert.equal(shell.set.MERV_AGENT_SESSION_TOKEN, undefined);
  assert.ok(!JSON.stringify(spec).includes(spec.env.MERV_AGENT_SESSION_TOKEN));
});

test('producer keeps its writable checkout and retained review remains sealed', () => {
  const producer = taskExecutionPolicy('work', 'code', true, true);
  const { spec, config } = launch(producer);
  assert.equal(spec.env.MERV_REVIEW_CODE, undefined);
  assert.equal(spec.args[spec.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(config.default_permissions, undefined);
  assert.equal(
    (config.shell_environment_policy as Record<string, any>).set.UV_CACHE_DIR,
    spec.cwd + '/.uv-cache',
  );
  // No checkout at this path: nothing beyond the workspace is writable.
  assert.deepEqual(
    { ...(config.sandbox_workspace_write as object) },
    {
      writable_roots: [],
      network_access: true,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: false,
    },
  );
  const sealed = launch({ ...producer, readOnly: true });
  assert.equal(sealed.spec.env.MERV_REVIEW_CODE, '1');
  assert.equal(sealed.spec.args[sealed.spec.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(sealed.config.default_permissions, undefined);
});
