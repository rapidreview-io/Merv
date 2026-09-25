import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createApp } from '../src/app.js';
import { defaultConfigFile } from '../src/config.js';
import { sandboxesPlugin } from '@merv/sandboxes';
import { sandboxesUiPlugin } from '@merv/sandboxes/ui';
import { sandboxesToolsPlugin } from '@merv/sandboxes/tools';
import { useRunSchema } from './database.js';
import { fakeGitHub, seedGit } from './ui-demo-git.js';

/**
 * Seeded local server for verifying the browser UI by hand: one project, four actors,
 * two tasks (one reviewed and done, one awaiting delivery) and a pinned review.
 * Type `disable <id>`, `enable <id>` (a plugin entry, such as `ui`) or `quit` on stdin.
 *
 * `--git` seeds the Git model as well: a bound and imported repository, units with their
 * commits, the bases the server merged from them and one publication. It runs in this process
 * because a commit needs a leased session and a base needs a repository holding real commits.
 *
 * Set both MERV_SANDBOXES_URL (the merv-sandboxes origin) and MERV_SANDBOXES_TOKEN (that
 * project's `sbxt_` consumer grant) to compose the optional sandboxes plugin for the demo
 * project, which publishes its own sidebar rows and its two tools from the service's manifest;
 * MERV_SANDBOXES_NAMESPACE overrides the `demo` namespace. `npm run fake:sandboxes` serves
 * all of it on port 3210. Without MERV_SANDBOXES_URL the demo composes exactly as before.
 *
 * State goes to the PostgreSQL that MERV_DB_URL names, in a schema derived from the data
 * directory (scripts/database.ts): set MERV_DEMO_DIR to reopen the same demo database, or
 * MERV_DB_SCHEMA to name one. MERV_DEMO_CONFIG names another plugin configuration.
 */
async function main() {
  const seedsGit = process.argv.includes('--git');
  if (seedsGit) fakeGitHub();
  const directory = process.env.MERV_DEMO_DIR ?? mkdtempSync(join(tmpdir(), 'merv-ui-demo-'));
  const schema = useRunSchema(directory);
  const app = await createApp({
    directory,
    configFile: process.env.MERV_DEMO_CONFIG ?? defaultConfigFile,
    port: Number(process.env.PORT ?? 3081),
  });
  const url = app.ctx.api.url!;
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Grokking replication',
    actorName: 'Operator',
  });
  const operator = { actorId: boot.actor.id, projectId: boot.project.id };
  const issue = async (name: string, role: 'producer' | 'reviewer' | 'reader') =>
    await app.ctx.scope.issueActor(operator, { name, role });
  const producer = await issue('Codex producer', 'producer');
  const reviewer = await issue('Claude reviewer', 'reviewer');
  const reader = await issue('Observer', 'reader');
  const as =
    (token: string) =>
    async (name: string, input: Record<string, unknown> = {}) => {
      const response = await fetch(`${url}/tools/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = (await response.json()) as {
        result?: any;
        error?: { code: string; message: string };
      };
      if (body.error) throw new Error(`${name}: ${body.error.code} ${body.error.message}`);
      return body.result;
    };
  const p = as(producer.token);
  const r = as(reviewer.token);

  const brief = await p('artifact.create', {
    title: 'Brief: reproduce grokking on modular addition',
    content: [
      '# Goal',
      'Show the delayed generalization curve with our training harness.',
      'Reproduce grokking on modular addition (p = 97) with a 1-layer transformer.',
      '',
      '# Done when',
      '1. Train accuracy 100% before step 2k',
      '2. Val accuracy > 95% after decay',
      '3. Curve and seed attached',
    ].join('\n'),
    mediaType: 'text/markdown',
  });
  const task = await p('task.create', {
    title: 'Reproduce grokking on modular addition',
    goal: 'Show the delayed generalization curve with our training harness.',
    checks: [
      'Train accuracy 100% before step 2k',
      'Val accuracy > 95% after decay',
      'Curve and seed attached',
    ],
    briefId: brief.id,
    requestId: 'demo-task-1',
  });
  const delivery = await p('artifact.create', {
    title: 'Delivery: grokking curve, seed 7',
    content: [
      '# Result',
      'Train accuracy hit 100% at step 1,640. Validation crossed 95% at step 9,810 with weight decay 1.0.',
      '',
      '## Checks',
      '- Train accuracy 100% before step 2k: yes, step 1,640.',
      '- Val accuracy > 95% after decay: yes, 97% at step 9,810.',
      '- Curve and seed attached: seed 7, table below.',
      '',
      '| step | train | val |',
      '|-----:|------:|----:|',
      '| 1000 | 0.62 | 0.01 |',
      '| 2000 | 1.00 | 0.02 |',
      '| 8000 | 1.00 | 0.31 |',
      '| 10000 | 1.00 | 0.97 |',
      '',
      'Seed: 7. Curve: see figure artifact.',
    ].join('\n'),
    mediaType: 'text/markdown',
  });
  const submitted = await p('task.submit_delivery', {
    taskId: task.id,
    artifactIds: [delivery.id],
    confirmations: [
      {
        checkNumber: 1,
        status: 'met',
        evidenceIds: [delivery.id],
        notes: 'Training accuracy reached 100% at step 1,640.',
      },
      {
        checkNumber: 2,
        status: 'met',
        evidenceIds: [delivery.id],
        notes: 'Validation accuracy reached 97% at step 9,810 with weight decay 1.0.',
      },
      {
        checkNumber: 3,
        status: 'met',
        evidenceIds: [delivery.id],
        notes: 'The delivery includes the learning-curve table and records seed 7.',
      },
    ],
    expectedRevision: task.workflow.revision,
    requestId: 'demo-delivery-1',
  });
  const started = await r('review.start', { reviewId: submitted.reviewId });
  await r('review.submit', {
    reviewId: submitted.reviewId,
    ...(started.claimId ? { claimId: started.claimId } : {}),
    expectedRevision: submitted.workflow.revision,
    verdict: 'pass',
    synopsis:
      'The seeded delivery reports both accuracy thresholds and retains the learning-curve table and seed.',
    findings: [
      {
        criterionNumber: 1,
        status: 'met',
        evidenceIds: [delivery.id],
        notes: 'The seeded report records training accuracy of 100% at step 1,640, before 2,000.',
      },
      {
        criterionNumber: 2,
        status: 'met',
        evidenceIds: [delivery.id],
        notes: 'The seeded report records validation accuracy of 97% after weight decay.',
      },
      {
        criterionNumber: 3,
        status: 'met',
        evidenceIds: [delivery.id],
        notes: 'The seeded delivery retains the learning-curve table and identifies seed 7.',
      },
    ],
    notes: 'Curve reproduces the published shape; seed and table are present. Accepting.',
    requestId: 'demo-verdict-1',
  });
  const brief2 = await p('artifact.create', {
    title: 'Brief: sweep weight decay',
    content:
      'Goal: Find where the grokking step moves as decay grows.\nSweep weight decay in {0.1, 0.3, 1.0, 3.0}.\nDone when:\n- Four runs complete\n- Grokking step reported per run',
  });
  const sweepTask = await p('task.create', {
    title: 'Sweep weight decay across four settings',
    goal: 'Find where the grokking step moves as decay grows.',
    checks: ['Four runs complete', 'Grokking step reported per run'],
    briefId: brief2.id,
    requestId: 'demo-task-2',
  });

  // Real local session/registry calls using disposable demo data, not live agent processes.
  const owner = { ...operator, credentialId: boot.credential.id };
  const joinAgent = async (name: string, requestId: string) => {
    const token = `ms_${randomBytes(32).toString('base64url')}`;
    const agent = await app.ctx.sessions.registerAgent(owner, {
      name,
      runnerId: 'local-demo',
      requestId,
      secret: token,
    });
    return { agent, token };
  };
  const previous = await joinAgent('Demo · prior research agent', 'demo-prior-agent');
  const historical = await app.ctx.tasks.create(owner, {
    title: 'Check training configuration',
    goal: 'Verify the training configuration.',
    checks: ['Configuration recorded.'],
    requestId: 'demo-agent-history',
  });
  const earlier = await app.ctx.sessions.assignAgent(previous.token, {
    instanceId: historical.id,
    expectedRevision: historical.workflow.revision,
    requestId: 'prior-assignment',
  });
  const earlierCaller = await app.ctx.sessions.authenticate(previous.token);
  await app.ctx.tools.call('artifact.create', earlierCaller, {
    title: 'Demo configuration',
    content: 'Recorded demo training configuration.',
  });
  await app.ctx.sessions.releaseAgentAssignment(previous.token, earlier.id);
  await app.ctx.sessions.retireAgent(owner, previous.agent.id);
  await joinAgent('Demo · waiting reviewer', 'demo-idle-agent');
  const working = await joinAgent('Demo · weight-decay researcher', 'demo-working-agent');
  const execution = await app.ctx.sessions.assignAgent(working.token, {
    instanceId: sweepTask.id,
    expectedRevision: sweepTask.workflow.revision,
    requestId: 'sweep-assignment',
  });
  const worker = await app.ctx.sessions.authenticate(working.token);
  await app.ctx.tools.call('workflow.assignment', worker, { instanceId: sweepTask.id });
  await app.ctx.tools.call('artifact.create', worker, {
    title: 'Demo sweep checkpoint',
    content: 'The four weight-decay settings and output locations are recorded for the demo.',
  });
  // Rows published by a service outside this process, read with this project's own grant.
  const sandboxes: string[] = [];
  if (process.env.MERV_SANDBOXES_URL) {
    const fiber = app.ctx.plugin(sandboxesPlugin, {
      urlEnv: 'MERV_SANDBOXES_URL',
      connections: [
        {
          projectId: boot.project.id,
          namespace: process.env.MERV_SANDBOXES_NAMESPACE ?? 'demo',
          tokenEnv: 'MERV_SANDBOXES_TOKEN',
        },
      ],
    });
    app.ctx.plugin(sandboxesToolsPlugin);
    app.ctx.plugin(sandboxesUiPlugin);
    await fiber.await();
    await app.ctx.sandboxes.refresh();
    sandboxes.push(...app.ctx.sandboxes.rows().map((row) => `${url}/ui${row.path}`));
  }

  const git = seedsGit ? await seedGit(app, owner) : undefined;

  const heartbeat = setInterval(async () => {
    try {
      await app.ctx.sessions.heartbeat(owner, { sessionId: execution.id, runnerId: 'local-demo' });
    } catch {
      clearInterval(heartbeat);
    }
  }, 20_000);
  heartbeat.unref();

  console.log(
    JSON.stringify(
      {
        status: 'ready',
        ui: `${url}/ui/`,
        directory,
        schema,
        ...(sandboxes.length ? { sandboxes } : {}),
        ...(git ? { git } : {}),
        tokens: {
          operator: boot.token,
          producer: producer.token,
          reviewer: reviewer.token,
          reader: reader.token,
        },
      },
      null,
      2,
    ),
  );
  const lines = createInterface({ input: process.stdin });
  lines.on('line', async (line) => {
    const [verb, id] = line.trim().split(/\s+/);
    try {
      if (verb === 'quit') {
        await app.stop();
        process.exit(0);
      } else if ((verb === 'disable' || verb === 'enable') && id) {
        await app.setEnabled(id, verb === 'enable');
        console.log(JSON.stringify({ [id]: app.status().find((entry) => entry.id === id)?.state }));
      } else console.log('commands: disable <id> | enable <id> | quit');
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
  });
  const stop = () => void app.stop().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
