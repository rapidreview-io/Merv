import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';
import { SignJWT } from 'jose';
import type { Project } from '@merv/contracts';
import { legacyHistoryUiPlugin } from '../src/legacy-history-ui.js';
import { importLegacyHistory } from '../src/legacy-history.js';
import { emptyLegacyHistorySnapshot, legacyHistoryRow } from '../tests/fixtures/legacy-history.js';

/**
 * Disposable synthetic UI acceptance fixture, expanded from ui-demo.ts.
 * Run: node --import tsx scripts/ui-overhaul-demo.ts
 * PORT defaults to an available loopback port. Credentials are saved only in the
 * new /private/tmp directory (mode 0600), never printed. No external provider calls.
 * For live UI editing: MERV_API=<reported api> PORT=5181 npm run dev:ui
 * Type enable/disable <plugin> or quit on stdin; SIGINT also closes the server.
 */
async function main() {
  const directory = mkdtempSync('/private/tmp/merv-ui-overhaul-');
  const secretEnv = 'MERV_UI_OVERHAUL_IDENTITY_SECRET';
  process.env[secretEnv] = randomBytes(48).toString('base64url');
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins.find(({ id }) => id === 'identity')!.config = {
    supabaseUrl: 'https://synthetic-ui.example.test',
    mode: 'hs256',
    secretEnv,
  };
  const api = config.plugins.find(({ id }) => id === 'api')!;
  const apiConfig = (api.config ?? {}) as { allowedOrigins?: string[] };
  api.config = {
    ...apiConfig,
    allowedOrigins: [...new Set([...(apiConfig.allowedOrigins ?? []), 'http://127.0.0.1:5181'])],
  };
  const app = await createApp({ directory, config, port: Number(process.env.PORT ?? 0) });
  const url = app.ctx.api.url!;
  const identity = async (subject: string) => {
    const token = await new SignJWT({ role: 'authenticated', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('https://synthetic-ui.example.test/auth/v1')
      .setSubject(subject)
      .setAudience('authenticated')
      .setExpirationTime('12h')
      .sign(new TextEncoder().encode(process.env[secretEnv]!));
    const principal = await app.ctx.scope.acceptVerifiedIdentity(
      await app.ctx.identity.verify(token),
    );
    return { token, principal };
  };
  const human = await identity('synthetic-ui-operator');
  const observer = await identity('synthetic-ui-reader');
  const projects: Project[] = [];
  for (const [index, name] of [
    'Grokking replication',
    'Sparse attention benchmarks',
    'Evidence synthesis',
    'Grokking replication',
    'Long-horizon optimization — open questions and negative results',
  ].entries()) {
    const project = await app.ctx.scope.createProject(human.principal, {
      name,
      requestId: `preview-project-${index}`,
    });
    projects.push(project);
    if (index < 3)
      await app.ctx.scope.addMember(human.principal, project.id, {
        subject: 'synthetic-ui-reader',
        role: 'reader',
      });
  }
  const operator = await app.ctx.scope.caller(human.principal, projects[0]!.id);
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
  await p('feed.post', {
    body: 'Grokking reproduced at seed 7; validation crosses 95% near step 9.8k. Delivery submitted.',
    artifactIds: [delivery.id],
    requestId: 'demo-post-1',
  });
  await r('feed.post', {
    body: 'Reviewed the curve against the brief: passes all three checks.',
    requestId: 'demo-post-2',
  });
  await p('feed.post', {
    body: 'Starting the weight-decay sweep next; expecting the step to move earlier with stronger decay.',
    requestId: 'demo-post-3',
  });

  // Real local session/registry calls using disposable demo data, not live agent processes.
  const owner = operator;
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
  const heartbeat = setInterval(async () => {
    try {
      await app.ctx.sessions.heartbeat(owner, { sessionId: execution.id, runnerId: 'local-demo' });
    } catch {
      clearInterval(heartbeat);
    }
  }, 20_000);
  heartbeat.unref();

  // Additional states use the same production service APIs; nothing is written directly to tables.
  const pendingReview = await p('task.create', {
    title: 'Check seed sensitivity in the weight-decay result',
    goal: 'Explain how seed choice affects the conclusion.',
    checks: ['State the uncertainty from the small seed set.'],
    requestId: 'preview-review-task',
  });
  const reviewEvidence = await p('artifact.create', {
    title: 'Seed sensitivity review packet',
    mediaType: 'text/markdown',
    content:
      '# Goal\nExplain how seed choice affects the conclusion.\n# Done when\nState the uncertainty from the small seed set.\n# Evidence\nSynthetic fixture: the observed spread is too wide for a strong conclusion.',
  });
  await p('task.submit_delivery', {
    taskId: pendingReview.id,
    expectedRevision: pendingReview.workflow.revision,
    artifactIds: [reviewEvidence.id],
    requestId: 'preview-review-delivery',
    confirmations: [
      {
        checkNumber: 1,
        status: 'met',
        evidenceIds: [reviewEvidence.id],
        notes: 'The synthetic packet explicitly states the uncertainty from the small seed set.',
      },
    ],
  });
  const blockedTask = await p('task.create', {
    title: 'Compare the four completed sweep settings',
    goal: 'Compare the sweep after every run is reviewed.',
    checks: ['Summarize the four settings.'],
    dependsOn: [sweepTask.id],
    requestId: 'preview-blocked-task',
  });
  const failedTask = await p('task.create', {
    title: 'Reproduce the older scheduler baseline',
    goal: 'Recover the old scheduler baseline.',
    checks: ['Recover a complete configuration.'],
    requestId: 'preview-failed-task',
  });
  await p('task.mark_failed', {
    taskId: failedTask.id,
    expectedRevision: failedTask.workflow.revision,
    reason: 'Synthetic negative result: the old configuration is incomplete.',
    requestId: 'preview-failed',
  });
  for (const [index, name] of [
    'weight-decay-sweep',
    'seed-sensitivity',
    'legacy-scheduler',
  ].entries()) {
    const experiment = await app.ctx.experiments.create(owner, {
      name,
      intent: 'Inspect the synthetic comparison and its limitations.',
      details: 'UI acceptance data only; no experiment was run.',
      requestId: `preview-experiment-${index}`,
    });
    if (index === 2)
      await app.ctx.experiments.transition(owner, {
        experimentId: experiment.id,
        expectedRevision: experiment.workflow.revision,
        transition: 'abandon',
        evidence: { reason: 'Synthetic fixture: required baseline data is unavailable.' },
        requestId: 'preview-experiment-abandon',
      });
  }
  await app.ctx.paper.patch(owner, {
    kind: 'problem',
    expectedRevision: 0,
    requestId: 'preview-paper',
    changes: [
      { id: 'problem', content: 'When does memorization give way to useful generalization?' },
      { id: 'scope', content: 'Synthetic modular addition comparisons for interface evaluation.' },
      {
        id: 'goals',
        content: 'Compare training curves, expose uncertainty, and retain independent review.',
      },
      { id: 'constraints', content: 'All values in this local preview are invented fixture data.' },
    ],
  });
  const cycle = await app.ctx.research.create(owner, {
    name: 'Understand delayed generalization',
    dependsOn: [sweepTask.id],
    requestId: 'preview-research-cycle',
  });
  await app.ctx.research.advance(owner, {
    researchId: cycle.id,
    expectedRevision: cycle.workflow.revision,
    requestId: 'preview-research-start',
  });
  for (const project of projects.slice(1, 3)) {
    const caller = await app.ctx.scope.caller(human.principal, project.id);
    await app.ctx.tasks.create(caller, {
      title: `Frame the next question for ${project.name}`,
      goal: 'Define a bounded comparison.',
      checks: ['Write a clear hypothesis.'],
      requestId: 'preview-secondary-task',
    });
    await app.ctx.feed.post(caller, {
      body: 'Synthetic preview: the project is ready for its first planning pass.',
      requestId: 'preview-secondary-feed',
    });
  }

  // A bounded archive fixture provides enough records to exercise cursor pagination.
  const snapshot = emptyLegacyHistorySnapshot([projects[0]!.id], 'ui-overhaul-synthetic-history');
  snapshot.tables.projects = [
    legacyHistoryRow('projects', {
      id: projects[0]!.id,
      name: projects[0]!.name,
      summary: 'Synthetic historical records',
      status: 'active',
      created_at: snapshot.capturedAt,
    }),
  ];
  snapshot.tables.experiments = Array.from({ length: 65 }, (_, index) =>
    legacyHistoryRow('experiments', {
      id: `synthetic-archive-exp-${String(index + 1).padStart(3, '0')}`,
      project_id: projects[0]!.id,
      name: `Archived comparison ${index + 1}`,
      details: 'Synthetic previous-backend record for navigation checks.',
      status: index % 7 ? 'complete' : 'abandoned',
      intent: 'exploratory',
      conclusion: 'Illustrative result only. This fixture contains no real research conclusions.',
      revision_context: null,
      attempt_index: 1,
      created_at: snapshot.capturedAt,
      updated_at: snapshot.capturedAt,
    }),
  );
  await importLegacyHistory(app.ctx.state, snapshot);
  const history = app.ctx.plugin(legacyHistoryUiPlugin, { sourceId: snapshot.sourceId });
  await history;
  const credentialsFile = join(directory, 'private-preview.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify(
      {
        api: url,
        ui: `${url}/ui/`,
        directory,
        projects,
        tokens: {
          operator: human.token,
          reader: observer.token,
          producer: producer.token,
          reviewer: reviewer.token,
        },
        mainProjectId: projects[0]!.id,
        records: {
          workingTask: sweepTask.id,
          blockedTask: blockedTask.id,
          reviewedTask: task.id,
          failedTask: failedTask.id,
          research: cycle.id,
        },
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    JSON.stringify(
      {
        status: 'ready',
        synthetic: true,
        api: url,
        ui: `${url}/ui/`,
        directory,
        credentialsFile,
        coverage: {
          projects: projects.length,
          readerProjects: 3,
          agents: { live: 1, idle: 1, retired: 1 },
          tasks: 'working, reviewed/done, awaiting review, blocked, failed',
          experiments: 3,
          researchCycles: 1,
          archivedExperiments: 65,
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
        clearInterval(heartbeat);
        await history.dispose();
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
  const stop = () => {
    clearInterval(heartbeat);
    void history
      .dispose()
      .then(() => app.stop())
      .then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
