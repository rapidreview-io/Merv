/** Local release-gate fixture only; bundled beside the image, never installed in it. */
import { readFileSync } from 'node:fs';
import { execution } from '../../packages/experiments/src/execution-policy.js';
import { programVersion } from '../../packages/experiments/src/program.js';
import { taskExecutionPolicy } from '../../packages/tasks/src/execution-policy.js';
import {
  buildLaunch,
  collectRepositorySkillPaths,
  validateProfile,
} from '../../packages/runner/src/profiles.js';
import type { Session } from '@merv/sessions/types';

const { kind, cwd, endpoint, secret, gitToken, commit } = JSON.parse(readFileSync(0, 'utf8'));
const policy =
  kind === 'task'
    ? taskExecutionPolicy('review', 'code', true, true)
    : execution(kind === 'plan' ? 'design_review' : 'experiment_review', programVersion);
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
  execution: { ...common, policy, references: { code: commit } },
  assignment: {
    ...common,
    workflow: kind === 'task' ? 'task' : 'experiment',
    references: [],
    execution: { readOnly: policy.readOnly },
    label: 'Review gate',
    brief: 'Run the shell probe.',
  },
} as unknown as Session;
const launch = buildLaunch(
  validateProfile({
    name: 'gate',
    harness: 'codex',
    executable: '/opt/merv/bin/codex',
    isolatedLauncher: '/opt/merv/runtime/assignment-probed.py',
    hosted: true,
    enabled: true,
    parallelism: 1,
    model: 'gpt-6.1-sol',
    effort: 'low',
  }),
  {
    session,
    cwd,
    secret,
    prompt: 'Run the shell probe, then stop.',
    mcpUrl: endpoint + '/mcp',
    disabledSkillPaths: collectRepositorySkillPaths(cwd),
    git: {
      url: endpoint + '/git/project_gate.git',
      token: gitToken,
      branch: null,
      startingCommit: commit,
    },
  },
  {},
);
// Only synthetic gate credentials enter this pipe. LaunchSpec's normal logging stays redacted.
process.stdout.write(
  JSON.stringify({
    executable: launch.executable,
    args: launch.args,
    cwd: launch.cwd,
    stdin: launch.stdin,
    env: Object.fromEntries(Object.entries(launch.env)),
    policy,
  }),
);
