import { NATIVE_CODE_DRIVER, type Caller } from '@merv/contracts';
import type { createApp } from '../src/app.js';
import { currentTask, type currentWork } from '../tests/fixtures/current-work.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Native Git seed; shares the demo's runner fixture and its cleanup lifecycle. */
export const buildMachine = {
  runnerId: 'demo-git-runner',
  machine: { hostname: 'build-01', system: 'linux', architecture: 'x86_64' },
  platforms: [{ name: 'test', harness: 'codex', enabled: true, parallelism: 1 }],
  capacity: 1,
  capabilities: [NATIVE_CODE_DRIVER],
};
export interface GitWriter {
  unitId: string;
  sessionId: string;
  runnerId: string;
  secret: string;
}

/** Ordinary commits and an unfinished working tree remain visible beside accepted demo work. */
export async function seedGit(
  app: Awaited<ReturnType<typeof createApp>>,
  operator: Caller,
  work: ReturnType<typeof currentWork>,
): Promise<{ report: Record<string, unknown>; writer: GitWriter }> {
  const task = await currentTask(app.ctx, operator, {
    title: 'Extend the reproducible training harness',
    goal: 'Keep the training harness and its run configuration together in the project remote.',
    checks: ['The harness and configuration are retained in ordinary Git history.'],
    requestId: 'demo-native-git-work',
  });
  const held = await work.lease(task, operator);
  buildMachine.runnerId = held.control.runnerId;
  const commits = [];
  commits.push(
    await work.commit(held, {
      'train/loop.py':
        'def train(model, data, steps):\n    for step in range(steps):\n        model.step(data)\n',
    }),
  );
  commits.push(
    await work.commit(held, {
      'configs/base.yaml': 'optimizer: adamw\nweight_decay: 1.0\ndepth: 1\n',
    }),
  );
  commits.push(
    await work.commit(held, {
      'runs/baseline.md': 'Seed 7. Reproduce the baseline before comparing ablations.\n',
    }),
  );
  // Session closure and task handoff do not create a commit. This is work still in progress.
  writeFileSync(
    join(held.workspace.path, 'next-run.md'),
    'Next: compare depth 2 and 4 with the same seed.\n',
  );
  const waiting = await currentTask(app.ctx, operator, {
    title: 'Review the next ablation design',
    goal: 'Specify the next comparison before a new run starts.',
    checks: ['The proposed comparison keeps the baseline and seed fixed.'],
    requestId: 'demo-native-git-waiting',
  });
  const status = await app.ctx.codeWork.status(operator);
  return {
    report: {
      remote: `/git/${operator.projectId}.git`,
      main: status.project?.main.oid,
      commits,
      active: task.id,
      waiting: waiting.id,
      counts: {
        units: status.units.length,
        bases: status.bases?.length ?? 0,
        integrations: status.publication?.records.length ?? 0,
      },
    },
    writer: {
      unitId: task.id,
      sessionId: held.session.id,
      runnerId: held.control.runnerId,
      secret: held.token,
    },
  };
}
