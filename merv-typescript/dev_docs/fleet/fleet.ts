/**
 * One project, many workers. Seeds a small but real research project into a running
 * Merv server and then lets a MachineRunner carry every stage of it with real Claude
 * Code workers, several at a time, exactly as production does. The only departure from
 * production is the executable: a wrapper that keeps the worker's session so it can be
 * interviewed after it finishes.
 *
 *   FLEET_BASE=http://127.0.0.1:3101 FLEET_PROJECT=project_… FLEET_OPERATOR_TOKEN=… \
 *     node --import tsx dev_docs/fleet/fleet.ts [--seed-only] [--no-seed]
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { MachineRunner } from '@merv/runner';

const BASE = process.env.FLEET_BASE ?? 'http://127.0.0.1:3101';
const PROJECT = process.env.FLEET_PROJECT!;
const OUT =
  process.env.FLEET_DIR ??
  '/private/tmp/claude-501/-Users-guraltoo-Documents-dev-proj-experiments-Merv/432a7267-efe6-4501-a97b-38a340f80fdd/scratchpad/fleet';
const WRAPPER = new URL('./fleet-claude.zsh', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const log = (entry: unknown) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...(entry as object) });
  appendFileSync(`${OUT}/fleet.log`, line + '\n');
  console.log(line);
};

async function call(tool: string, body: unknown = {}): Promise<any> {
  const response = await fetch(`${BASE}/tools/${tool}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.FLEET_OPERATOR_TOKEN}`,
      'content-type': 'application/json',
      'x-merv-project-id': PROJECT,
    },
    body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (value.error) throw new Error(`${tool}: ${value.error.code}: ${value.error.message}`);
  return value.result;
}

/** The project: modular addition, small enough that a worker can actually run it. */
const CLAIMS = [
  {
    key: 'C1',
    statement:
      'A one-hidden-layer network trained on addition modulo 13 reaches 0.9 validation accuracy only when weight decay is at least 1e-3.',
    scope: 'Addition mod 13, one hidden layer of 128 units, full-batch training, 3 seeds.',
    confidence: 'medium' as const,
  },
  {
    key: 'C2',
    statement:
      'Raising the training fraction from 0.3 to 0.5 at least halves the number of steps to 0.9 validation accuracy.',
    scope: 'Same network and task, weight decay fixed at 1e-3, 3 seeds.',
    confidence: 'medium' as const,
  },
  {
    key: 'C3',
    statement:
      'The delay between the step at which training accuracy reaches 0.99 and the step at which validation accuracy reaches 0.9 narrows monotonically as weight decay increases.',
    scope: 'Weight decay in {0, 1e-4, 1e-3, 1e-2}, same network and task.',
    confidence: 'low' as const,
  },
];

const HARNESS_NOTE =
  'Everything in this project runs on this machine with python3 and numpy 1.26 in the worker workspace. There is no GPU, no network and no dataset to download: addition modulo 13 is 169 pairs, generated in the script. A full run of one setting is seconds. Keep every run under two minutes of CPU.';

const TASKS = [
  {
    key: 'harness',
    title: 'Write the modular-addition training harness',
    goal: `Write a single self-contained python3 script that trains a one-hidden-layer network on addition modulo 13 and records its learning curve, so that every later measurement in this project uses the same code. ${HARNESS_NOTE} The script takes weight decay, training fraction, seed and step budget as arguments, prints one JSON object per run with the accuracy curve, and is saved as an artifact with artifact.create. Run it at least once and show the output you got.`,
    checks: [
      'The script is attached as an artifact and runs as shown, with the exact command and its output quoted from a real run',
      'It accepts weight decay, training fraction, seed and step budget, and its JSON output records train and validation accuracy against step',
      'Two runs with the same seed and settings produce the same numbers, demonstrated by running it twice',
    ],
  },
  {
    key: 'protocol',
    title: 'Fix the evaluation protocol for this project',
    goal: 'Decide and write down, as an artifact, how every experiment in this project reports its result: which seeds, how the train/validation split is drawn, what counts as "reached 0.9 validation accuracy" for a noisy curve, and how a run that never reaches it is reported. This is a decision document, not code. Be specific enough that two workers following it independently would report the same number from the same run.',
    checks: [
      'The document names the exact seeds and the exact split procedure',
      'It defines the step at which a threshold is considered reached, including the noisy and never-reached cases',
      'It states what a result table must contain for a reader to check it',
    ],
  },
  {
    key: 'baseline',
    title: 'Measure the no-weight-decay baseline',
    goal: `Run the training with weight decay 0 at training fraction 0.5 for three seeds and report what happens to validation accuracy within the step budget. ${HARNESS_NOTE} If the harness task has not delivered a script yet, write the smallest script you need, run it, and attach it: this measurement is the point, not the sharing of code.`,
    checks: [
      'Three seeds are run and each run is reported with its own numbers',
      'The reported numbers come from a run performed during this task, with the command and raw output attached',
      'The report states plainly whether validation accuracy reached 0.9 and at which step, or that it did not',
    ],
  },
];

const EXPERIMENTS = [
  {
    key: 'wd-sweep-mod13',
    intent:
      'Measure whether weight decay is what makes the network generalize on addition modulo 13, and whether the generalization delay shrinks as weight decay rises. This tests C1 and C3.',
    details: `Weight decay in {0, 1e-4, 1e-3, 1e-2} at training fraction 0.5, three seeds each, twelve runs. ${HARNESS_NOTE} Report, per setting, the step at which validation accuracy first reaches 0.9 (or that it did not within the budget) and the step at which training accuracy first reaches 0.99. The result is the table; a setting that never generalizes is a result, not a failure.`,
    claims: ['C1', 'C3'],
  },
  {
    key: 'trainfrac-mod13',
    intent:
      'Measure how the amount of training data changes the time to generalization, at fixed weight decay. This tests C2.',
    details: `Training fraction in {0.3, 0.4, 0.5} with weight decay fixed at 1e-3, three seeds each, nine runs. ${HARNESS_NOTE} Report, per setting, the step at which validation accuracy first reaches 0.9, and state the ratio between the 0.3 and 0.5 settings with its spread across seeds.`,
    claims: ['C2'],
  },
];

async function seed(): Promise<{ records: string[]; research?: string }> {
  const ids = new Map<string, string>();
  const summary = await call('project.get');
  if (!summary.summary)
    await call('project.context.update', {
      summary: `Grokking replication — wave 2. ${HARNESS_NOTE} The question this wave answers: what makes a small network stop memorising addition modulo 13 and start generalising — weight decay, or the amount of data it sees? Every number in this project is measured by a worker on this machine and attached to the record that claims it; no number is carried over from the literature. Earlier work in this project (the seed-7 curve) used a different task size and is history, not evidence.`,
      expectedSummary: '',
      requestId: `fleet:context:${RUN}`,
    });
  for (const claim of CLAIMS) {
    const made = await call('claim.create', {
      statement: claim.statement,
      scope: claim.scope,
      confidence: claim.confidence,
      requestId: `fleet:claim:${claim.key}`,
    });
    ids.set(claim.key, made.id);
    log({ claim: claim.key, id: made.id });
  }
  const records: string[] = [];
  for (const task of TASKS) {
    const made = await call('task.create', {
      title: task.title,
      goal: task.goal,
      checks: task.checks,
      requestId: `fleet:task:${task.key}`,
    });
    ids.set(task.key, made.id);
    records.push(made.id);
    log({ task: task.key, id: made.id });
  }
  for (const experiment of EXPERIMENTS) {
    const made = await call('experiment.create', {
      name: experiment.key,
      intent: experiment.intent,
      details: experiment.details,
      testedClaimIds: experiment.claims.map((key) => ids.get(key)!),
      requestId: `fleet:experiment:${experiment.key}`,
    });
    ids.set(experiment.key, made.id);
    records.push(made.id);
    log({ experiment: experiment.key, id: made.id });
  }
  const cycle = await call('research.create', {
    name: 'What makes it generalise — wave 2',
    dependsOn: records,
    consolidationWorkspace: 'none',
    requestId: `fleet:cycle:wave2`,
  });
  log({ research: cycle.id });
  return { records, research: cycle.id };
}

const RUN = randomBytes(3).toString('hex');

async function main() {
  const seedOnly = process.argv.includes('--seed-only');
  let records: string[] = [];
  let research: string | undefined;
  if (!process.argv.includes('--no-seed')) ({ records, research } = await seed());
  if (seedOnly) return;

  const runner = new MachineRunner({
    directory: `${OUT}/machine`,
    baseUrl: BASE,
    projectId: PROJECT,
    credentialEnv: 'FLEET_OPERATOR_TOKEN',
    capacity: 5,
    pollIntervalMs: 6000,
    profiles: [
      {
        name: 'fleet-claude',
        harness: 'claude',
        executable: WRAPPER,
        enabled: true,
        parallelism: 5,
        model: process.env.FLEET_MODEL ?? 'opus',
        effort: (process.env.FLEET_EFFORT as 'high') ?? 'high',
      },
    ],
  });
  await runner.start();
  log({ runner: 'started', parallelism: 5, executable: WRAPPER });

  let draining = false;
  process.once('SIGUSR2', () => {
    draining = true;
    log({ draining: true });
  });

  const overview = async () => {
    const status = await call('workflow.status_and_next', {});
    const sessions = await fetch(`${BASE}/sessions/status`, {
      headers: {
        authorization: `Bearer ${process.env.FLEET_OPERATOR_TOKEN}`,
        'x-merv-project-id': PROJECT,
      },
    })
      .then((r) => r.json())
      .catch(() => ({}));
    return { status, sessions: sessions?.sessions ?? sessions };
  };

  const deadline = Date.now() + 1000 * 60 * 60 * 6;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    try {
      const { status, sessions } = await overview();
      const live = (Array.isArray(sessions) ? sessions : []).filter((s: any) =>
        ['offered', 'active'].includes(s.status),
      );
      log({
        ready: (status?.ready ?? []).map((r: any) => `${r.workflow}:${r.state}`),
        blocked: (status?.blocked ?? []).length,
        terminal: (status?.terminal ?? []).length,
        live: live.map((s: any) => `${s.instanceId?.slice(-6)}:${s.status}`),
        snapshot: runner.snapshot?.()?.launches?.length,
      });
      // The cycle's own gate is the operator's to advance; a worker never advances it.
      if (research) {
        const gate = await call('workflow.status_and_next', { instanceId: research });
        if (gate?.nextAction?.action === 'advance' && gate?.currentGate !== 'blocked')
          await call('research.advance', {
            researchId: research,
            expectedRevision: gate.revision,
            requestId: `fleet:advance:${research}:${gate.revision}`,
          }).then(
            (r) => log({ advanced: research, to: r?.state }),
            (e) => log({ advanceRefused: String(e).slice(0, 200) }),
          );
      }
      if (draining) break;
      if ((status?.ready ?? []).length === 0 && live.length === 0 && (status?.blocked ?? []).length === 0) {
        log({ done: true });
        break;
      }
    } catch (error) {
      log({ overviewError: String(error).slice(0, 300) });
    }
  }
  await runner.stop?.();
  log({ runner: 'stopped' });
}

main().catch((error) => {
  log({ fatal: String(error) });
  process.exit(1);
});
