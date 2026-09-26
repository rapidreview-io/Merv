import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  digest,
  type Caller,
  type ReviewRequest,
  type RunningPanel,
  type RunningPhrase,
  type RunningSection,
  type Task,
  type TaskReview,
} from '@merv/contracts';
import type { Experiment, ExperimentAttach } from '@merv/experiments/types';
import type { RunningRead } from '@merv/ui';
import { reviewSections } from '@merv/reviews/running';
import { citedEvidence, feasibilityStatement } from './feasibility-fixture.js';
import { createApp } from './fixtures/app.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';

/**
 * Reviews' part of the Running page: the Review section it adds to the sidebar of any work a
 * review judges, read on PostgreSQL through the service and through ui.running_panel.
 */

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-running-reviews-'));
  // The committed composition, browser layer included, on a port of its own.
  const { plugins } = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as { plugins: { id: string; config?: unknown }[] };
  const app = await createApp({
    directory: join(directory, 'data'),
    config: {
      plugins: plugins.map((entry) =>
        entry.id === 'api'
          ? { ...entry, config: { host: '127.0.0.1', port: 0 } }
          : entry.id === 'ui'
            ? { ...entry, config: { assets: join(directory, 'nowhere') } }
            : entry,
      ) as never,
    },
  });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Running reviews',
    actorName: 'Operator',
  });
  const operator: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const issued = await app.ctx.scope.issueActor(operator, { name: `The ${role}`, role });
    const caller: Caller = {
      projectId: operator.projectId,
      actorId: issued.actor.id,
      credentialId: issued.credential.id,
    };
    return { caller, token: issued.token };
  };
  const producer = await issue('producer');
  const reader = await issue('reader');
  let sequence = 0;
  const task = async () =>
    await app.ctx.tasks.create(producer.caller, {
      title: `Check adder ${++sequence}`,
      goal: 'Verify addition.',
      checks: ['Positive inputs work.', 'Negative inputs work.'],
      requestId: `create-${sequence}`,
    });
  const deliver = async (subject: Task) => {
    const proof = await app.ctx.artifacts.create(producer.caller, {
      title: 'Execution receipts',
      mediaType: 'application/json',
      content: '{"positive":5,"negative":-1}',
    });
    return await app.ctx.tasks.submitDelivery(
      producer.caller,
      confirmedDelivery(
        {
          taskId: subject.id,
          artifactIds: [proof.id],
          expectedRevision: subject.workflow.revision,
          requestId: `delivery-${++sequence}`,
        },
        2,
      ),
    );
  };
  /** A needs_changes verdict on the claimed review: the negative case is not met. */
  const sendBack = (review: ReviewRequest, subject: Task): TaskReview => ({
    reviewId: review.id,
    claimId: review.claimId!,
    expectedRevision: subject.workflow.revision,
    verdict: 'needs_changes',
    notes: 'Recomputed both retained cases independently.',
    synopsis:
      'Negative inputs produce the wrong sign. The positive case holds as delivered and needs no change.',
    findings: review.criteria.map((_, index) =>
      index === 1
        ? {
            criterionNumber: 2,
            status: 'not_met',
            evidenceIds: [],
            notes: 'Negative inputs produce the wrong sign.',
          }
        : {
            criterionNumber: index + 1,
            status: 'met',
            evidenceIds: [...review.artifactIds],
            notes: `Recomputed case ${index + 1} from the retained receipt.`,
          },
    ),
    requestId: `verdict-${++sequence}`,
  });
  const sections = async (caller: Caller, ...subjectIds: string[]) =>
    await app.ctx.reviews.running(caller, subjectIds);
  return { app, boot, operator, producer, reader, issue, task, deliver, sendBack, sections };
}

const titled = (sections: RunningSection[], title: string) =>
  sections.find((section) => section.title === title);
const facts = (section: RunningSection | undefined): Record<string, RunningPhrase> =>
  Object.fromEntries(
    section?.kind === 'facts' ? section.rows.map(({ label, value }) => [label, value]) : [],
  );
const open = (reviewId: string) => ({
  link: { route: `/reviews/${reviewId}` },
  text: 'Open the review',
});

/** Every word a reader could see: titles, labels, names and the words inside each phrase. */
function words(sections: RunningSection[]): string[] {
  const phrase = (value: RunningPhrase = []) =>
    value.flatMap((part) =>
      typeof part === 'string'
        ? [part]
        : 'link' in part
          ? [part.text]
          : 'state' in part
            ? [part.state]
            : 'unnamed' in part && part.unnamed
              ? [part.unnamed]
              : [],
    );
  return sections.flatMap((section) => [
    section.title,
    ...phrase(section.aside),
    ...(section.kind === 'facts'
      ? section.rows.flatMap((row) => [row.label, ...phrase(row.value)])
      : section.kind === 'links'
        ? section.rows.flatMap((row) => [row.name, ...phrase(row.says)])
        : []),
  ]);
}

test('a task review reads unclaimed, then whose it is and for how long, then its verdict, and earlier rounds link to their reviews newest first', async (t) => {
  const f = await fixture(t);
  const reviewer = await f.issue('reviewer');
  const subject = await f.task();
  assert.deepEqual(await f.sections(f.operator, subject.id), [], 'absent before a delivery');

  const first = await f.deliver(subject);
  const requested = await f.app.ctx.reviews.get(f.operator, first.reviewId!);
  const unclaimed = await f.sections(f.operator, first.id);
  assert.deepEqual(
    unclaimed.map(({ title, place, kind }) => ({ title, place, kind })),
    [{ title: 'Review', place: 'review', kind: 'facts' }],
  );
  assert.deepEqual(facts(unclaimed[0]), {
    Standing: ['Unclaimed'],
    Requested: [{ ago: requested.createdAt }],
    'Verdict page': [open(requested.id)],
  });
  assert.equal(unclaimed[0].attention, undefined);

  // A claim names its reviewer as an actor the shell names, and runs from the claim's event.
  const claimed = await f.app.ctx.reviews.start(reviewer.caller, requested.id);
  const started = (await f.app.ctx.state.events(f.operator.projectId)).find(
    (event) => event.type === 'review.started' && event.subjectId === requested.id,
  );
  assert.ok(started);
  for (const caller of [f.operator, f.reader.caller])
    assert.deepEqual(facts((await f.sections(caller, first.id))[0]), {
      Standing: [{ actor: reviewer.caller.actorId, prefix: 'With ', unnamed: 'Claimed' }],
      Requested: [{ ago: requested.createdAt }],
      'Claimed for': [{ since: started.createdAt }],
      'Verdict page': [open(requested.id)],
    });

  // The verdict that sent the work back stays while the producer is on it again.
  const returned = await f.app.ctx.tasks.submitReview(reviewer.caller, f.sendBack(claimed, first));
  assert.equal(returned.workflow.state, 'in_progress');
  const decided = (await f.sections(f.operator, first.id))[0];
  assert.deepEqual(facts(decided), {
    Standing: [{ state: 'needs_changes' }],
    Requested: [{ ago: requested.createdAt }],
    Verdict: ['Negative inputs produce the wrong sign.'],
    Checks: [{ count: 1, of: 2 }, ' not met'],
    'Verdict page': [open(requested.id)],
  });
  // The way to the review stands alone, as the last row's whole value, so the shell draws it
  // at the size of a control; no other value carries a link.
  assert.ok(decided.kind === 'facts');
  assert.deepEqual(decided.rows.at(-1), { label: 'Verdict page', value: [open(requested.id)] });
  assert.ok(
    decided.rows
      .slice(0, -1)
      .every(({ value }) => value.every((part) => typeof part === 'string' || !('link' in part))),
  );

  // Each new delivery is a new round; the ones before it are one line each, newest first.
  const second = await f.deliver(returned);
  const again = await f.app.ctx.reviews.get(f.operator, second.reviewId!);
  const reread = await f.sections(f.operator, first.id);
  assert.deepEqual(facts(titled(reread, 'Review')).Standing, ['Unclaimed']);
  assert.deepEqual(facts(titled(reread, 'Review'))['Verdict page'], [open(again.id)]);
  assert.deepEqual(titled(reread, 'Earlier rounds'), {
    title: 'Earlier rounds',
    place: 'review',
    kind: 'links',
    aside: [{ count: 1 }],
    rows: [
      {
        to: { route: `/reviews/${requested.id}` },
        name: 'Needs changes',
        says: [{ ago: requested.createdAt }],
      },
    ],
  });
  const reclaimed = await f.app.ctx.reviews.start(reviewer.caller, again.id);
  const third = await f.deliver(
    await f.app.ctx.tasks.submitReview(reviewer.caller, f.sendBack(reclaimed, second)),
  );
  const latest = await f.sections(f.operator, first.id);
  assert.deepEqual(facts(titled(latest, 'Review'))['Verdict page'], [open(third.reviewId!)]);
  const earlier = titled(latest, 'Earlier rounds');
  assert.ok(earlier?.kind === 'links');
  assert.deepEqual(
    earlier.rows.map(({ to }) => to),
    [{ route: `/reviews/${again.id}` }, { route: `/reviews/${requested.id}` }],
  );
  assert.deepEqual(earlier.aside, [{ count: 2 }]);

  // Nobody is named by an identifier anywhere in the words.
  for (const word of words(latest))
    assert.doesNotMatch(word, /\b(?:wf|review|actor|art|task|project|claim)_[A-Za-z0-9]/);
  assert.deepEqual(await f.sections(f.operator, subject.id, 'nothing'), latest);
});

test('why nobody can take a review is said to an operator alone, in ink, and another project reads nothing of it', async (t) => {
  const f = await fixture(t);
  const proof = await f.app.ctx.artifacts.create(f.producer.caller, {
    title: 'Proof',
    content: 'Observed.',
  });
  // Every eligible reviewer, the operator, contributed to the subject.
  t.after(
    f.app.ctx.reviews.provenance('fixture').register(async () => {
      const body = {
        revalidate: true as const,
        formatVersion: 1 as const,
        provider: 'fixture',
        reference: 'subject',
        sourceHash: digest([f.operator.actorId]),
        excludedActorIds: [f.operator.actorId],
      };
      return { ...body, hash: digest(body) };
    }),
  );
  const review = await f.app.ctx.reviews.request(f.producer.caller, {
    subjectId: 'subject',
    subjectRevision: 0,
    producerId: f.producer.caller.actorId,
    artifactIds: [proof.id],
    criteria: ['Correct'],
    provenanceOwner: 'fixture',
    requestId: 'certified',
  });

  // The work's own card carries the red and whose move it is; the section says why, in ink,
  // and keeps its place in the panel rather than sorting to the top.
  const [held] = await f.sections(f.operator, 'subject');
  assert.equal(held.attention, undefined);
  assert.ok(held.kind === 'facts');
  assert.deepEqual(held.rows, [
    { label: 'Standing', value: ['Unclaimed'] },
    { label: 'No reviewer', value: ['Every eligible reviewer contributed to this work'] },
    { label: 'Requested', value: [{ ago: review.createdAt }] },
    { label: 'Verdict page', value: [open(review.id)] },
  ]);
  const [read] = await f.sections(f.reader.caller, 'subject');
  assert.equal(read.attention, undefined);
  assert.deepEqual(Object.keys(facts(read)), ['Standing', 'Requested', 'Verdict page']);

  // A domain names a gate only in words; anything else it answers leaves the standing bare.
  let named: unknown = { [review.id]: ' ', elsewhere: 'Design' };
  t.after(
    f.app.ctx.reviews.registerSubmitOwner({
      id: 'gated',
      owns: async () => false,
      submit: async () => null,
      gates: async () => named as Record<string, string>,
    }),
  );
  assert.deepEqual(facts((await f.sections(f.operator, 'subject'))[0]).Standing, ['Unclaimed']);
  named = Object.assign(Object.create({ [review.id]: 'Design' }), {});
  assert.deepEqual(facts((await f.sections(f.operator, 'subject'))[0]).Standing, ['Unclaimed']);
  named = { [review.id]: 'Design' };
  assert.deepEqual(facts((await f.sections(f.operator, 'subject'))[0]).Standing, [
    'Design · ',
    'unclaimed',
  ]);

  const elsewhere = await f.app.ctx.scope.bootstrap({ projectName: 'Elsewhere', actorName: 'Op' });
  assert.deepEqual(
    await f.sections(
      { projectId: elsewhere.project.id, actorId: elsewhere.actor.id },
      'subject',
      review.id,
    ),
    [],
  );
  assert.deepEqual(await f.sections(f.operator), []);
});

test('an experiment names the gate each review read, in the standing and in every earlier round', async (t) => {
  const f = await fixture(t);
  const reviewer = await f.issue('reviewer');
  const plan =
    '# Summary\nA paired comparison.\n# Objective & hypothesis\nThe change should improve validation accuracy.\n# Evaluation\nCompare two fixed seeds and matched controls.';
  const report =
    '# Summary\nThe result refuted the hypothesis.\n# Results\nmetrics_exhibit.json reports the retained observations.\n# Deviations from plan\nNone.\n# Conclusion\nNo improvement was observed.';
  let sequence = 0;
  const request = () => `experiment-${++sequence}`;
  let experiment = await f.app.ctx.experiments.create(f.operator, {
    name: 'ablate-retrieval-depth',
    intent: 'Does retrieval depth change held-out accuracy?',
    requestId: request(),
  });
  const attach = async (role: ExperimentAttach['role'], path: string, content: string) => {
    const artifact = await f.app.ctx.artifacts.create(f.operator, {
      title: role,
      content,
      mediaType: path.endsWith('.md') ? 'text/markdown' : 'application/json',
    });
    await f.app.ctx.experiments.attach(f.operator, {
      experimentId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      attemptIndex: experiment.attempt.index,
      artifactId: artifact.id,
      role,
      path,
      requestId: request(),
    });
    experiment = await f.app.ctx.experiments.get(f.operator, experiment.id);
  };
  const submit = async (transition: 'submit_design' | 'submit_results') => {
    experiment = await f.app.ctx.experiments.transition(f.operator, {
      experimentId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      transition,
      requestId: request(),
    });
    return experiment.reviewId!;
  };
  const design = async () => {
    await attach('feasibility', 'feasibility.json', feasibilityStatement());
    await attach('plan', 'design/plan.md', plan);
    return await submit('submit_design');
  };
  const judge = async (reviewId: string, verdict: 'pass' | 'needs_changes') => {
    const review = await f.app.ctx.reviews.start(reviewer.caller, reviewId);
    experiment = (await f.app.ctx.reviews.apply(reviewer.caller, {
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: experiment.workflow.revision,
      verdict,
      notes: 'Independently checked the retained design.',
      synopsis: 'The design has been independently assessed.',
      findings: review.criteria.map((_, index) => ({
        criterionNumber: index + 1,
        status: verdict === 'pass' ? 'met' : 'not_met',
        evidenceIds: citedEvidence(experiment, review, index + 1),
        notes: 'I inspected the retained evidence for this criterion.',
      })),
      requestId: request(),
    })) as Experiment;
  };
  const read = async () => {
    const sections = await f.sections(f.operator, experiment.id);
    const earlier = titled(sections, 'Earlier rounds');
    return {
      standing: facts(titled(sections, 'Review')).Standing,
      earlier: earlier?.kind === 'links' ? earlier.rows.map(({ name }) => name) : [],
    };
  };

  const first = await design();
  assert.deepEqual(await read(), { standing: ['Design · ', 'unclaimed'], earlier: [] });
  await judge(first, 'needs_changes');
  assert.equal(experiment.workflow.state, 'planned');
  await judge(await design(), 'pass');
  assert.equal(experiment.workflow.state, 'running');
  // A monitor reads that the design passed, not that the experiment did.
  assert.deepEqual(await read(), {
    standing: ['Design · ', { state: 'pass' }],
    earlier: ['Design · needs changes'],
  });

  await attach('result', 'result.json', '{"accuracy":0.5}');
  await attach('report', 'report.md', report);
  await submit('submit_results');
  assert.deepEqual(await read(), {
    standing: ['Results · ', 'unclaimed'],
    earlier: ['Design · pass', 'Design · needs changes'],
  });
  // A task is reviewed at one gate, so it names none.
  const task = await f.deliver(await f.task());
  assert.deepEqual(facts((await f.sections(f.operator, task.id))[0]).Standing, ['Unclaimed']);

  // The gate is read inside ui.running_panel's snapshot as well, for a reader too.
  t.after(
    f.app.ctx.ui.contribute({
      owner: 'probe',
      kinds: ['work'],
      panel: async () => ({
        header: { kind: 'Experiment', title: 'Probe', says: [] },
        sections: [],
        actions: [],
        live: false,
      }),
    }),
  );
  const response = await fetch(`${f.app.ctx.api.url}/tools/ui.running_panel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${f.reader.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key: `work:${experiment.id}` }),
  });
  assert.equal(response.status, 200);
  const { sections } = ((await response.json()) as { result: RunningPanel }).result;
  assert.deepEqual(facts(titled(sections, 'Review')).Standing, ['Results · ', 'unclaimed']);
  const rounds = titled(sections, 'Earlier rounds');
  assert.ok(rounds?.kind === 'links');
  assert.deepEqual(
    rounds.rows.map(({ name }) => name),
    ['Design · pass', 'Design · needs changes'],
  );
});

test('an agent that took the review with its lease reads as an agent, and the sidebar carries the section inside the tool snapshot', async (t) => {
  const f = await fixture(t);
  const token = `ms_${randomBytes(32).toString('base64url')}`;
  const agent = await f.app.ctx.sessions.registerAgent(f.operator, {
    name: 'Reviewing agent',
    runnerId: 'external',
    requestId: 'register',
    secret: token,
  });
  const delivered = await f.deliver(await f.task());
  const lease = await f.app.ctx.sessions.assignAgent(token, {
    instanceId: delivered.id,
    expectedRevision: delivered.workflow.revision,
    requestId: 'review-lease',
  });
  assert.equal(lease.role, 'reviewer');
  const claim = (await f.app.ctx.state.events(f.operator.projectId)).find(
    (event) => event.type === 'review.started' && event.subjectId === delivered.reviewId,
  );
  assert.ok(claim);
  const standing = facts((await f.sections(f.operator, delivered.id))[0]);
  assert.deepEqual(standing.Standing, [
    { actor: agent.actorId, prefix: 'With ', unnamed: 'With an agent' },
  ]);
  assert.deepEqual(standing['Claimed for'], [{ since: claim.createdAt }]);

  // The contribution reads only work keys: a lens, a session or a machine has no review.
  const contribution = f.app.ctx.ui.contributions().find(({ owner }) => owner === 'reviews');
  assert.ok(contribution?.sections && !contribution.nodes && !contribution.panel);
  const read: RunningRead = {
    caller: f.operator,
    include: new Set(),
    once: async <T>(_name: string, value: () => Promise<T>) => await value(),
  };
  assert.deepEqual(
    await contribution.sections(read, [`session:${lease.id}`, `fleet:${delivered.id}`]),
    [],
  );

  // Through ui.running_panel, for whoever reads the project, on the key another owner draws.
  const quiet = await f.task();
  t.after(
    f.app.ctx.ui.contribute({
      owner: 'probe',
      kinds: ['work'],
      panel: async () => ({
        header: { kind: 'Task', title: 'Probe', says: [] },
        sections: [],
        actions: [],
        live: false,
      }),
    }),
  );
  const panel = async (bearer: string, key: string) => {
    const response = await fetch(`${f.app.ctx.api.url}/tools/ui.running_panel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    assert.equal(response.status, 200);
    return ((await response.json()) as { result: RunningPanel }).result.sections.filter(
      ({ owner }) => owner === 'reviews',
    );
  };
  for (const bearer of [f.boot.token, f.reader.token]) {
    const ours = await panel(bearer, `work:${delivered.id}`);
    assert.deepEqual(
      ours.map(({ title, place }) => ({ title, place })),
      [{ title: 'Review', place: 'review' }],
    );
    assert.deepEqual(facts(ours[0]).Standing, standing.Standing);
  }
  assert.deepEqual(await panel(f.boot.token, `work:${quiet.id}`), []);
});

test('a pass on waivers says so, notes stand in for a missing synopsis, and a superseded round keeps its word', () => {
  const base: ReviewRequest = {
    id: 'review_current',
    projectId: 'project_1',
    subjectId: 'wf_1',
    subjectRevision: 2,
    producerId: 'actor_producer',
    artifactIds: ['art_1'],
    criteria: ['One', 'Two', 'Three'],
    formatVersion: 2,
    snapshotHash: 'hash',
    status: 'submitted',
    reviewerId: 'actor_reviewer',
    claimId: 'claim_1',
    claimGeneration: 1,
    recovery: null,
    verdict: 'pass',
    notes: 'Both waivers are recorded with their reasons.\nThe rest holds.',
    synopsis: null,
    findings: [
      { criterionNumber: 1, status: 'met', evidenceIds: ['art_1'], notes: 'Holds.' },
      { criterionNumber: 2, status: 'waived', evidenceIds: [], notes: 'Out of scope.' },
      { criterionNumber: 3, status: 'waived', evidenceIds: [], notes: 'Out of scope.' },
    ],
    evidence: {},
    createdAt: '2026-09-25T10:00:00.000Z',
  };
  const [review, earlier] = reviewSections({
    current: base,
    earlier: [
      {
        id: 'review_old',
        status: 'superseded',
        verdict: null,
        createdAt: '2026-09-25T09:00:00.000Z',
      },
    ],
  });
  assert.deepEqual(facts(review), {
    Standing: [{ state: 'pass' }],
    Requested: [{ ago: base.createdAt }],
    Verdict: ['Both waivers are recorded with their reasons.'],
    Checks: [{ count: 2, of: 3 }, ' waived'],
    'Verdict page': [open('review_current')],
  });
  assert.ok(earlier.kind === 'links');
  assert.equal(earlier.rows[0].name, 'Superseded');
  // A claim whose event is gone still stands, without a clock.
  const [claimed] = reviewSections({
    current: { ...base, status: 'started', verdict: null, findings: [] },
    earlier: [],
  });
  assert.deepEqual(facts(claimed), {
    Standing: [{ actor: 'actor_reviewer', prefix: 'With ', unnamed: 'Claimed' }],
    Requested: [{ ago: base.createdAt }],
    'Verdict page': [open('review_current')],
  });
});

test('a gate opens the standing and every earlier round, and the clause after it runs on in lower case', () => {
  const current = {
    id: 'review_results',
    projectId: 'project_1',
    subjectId: 'wf_1',
    subjectRevision: 4,
    producerId: 'actor_producer',
    artifactIds: ['art_1'],
    criteria: ['One'],
    snapshotHash: 'hash',
    status: 'requested',
    reviewerId: null,
    claimId: null,
    claimGeneration: 0,
    recovery: null,
    verdict: null,
    notes: null,
    synopsis: null,
    findings: [],
    evidence: {},
    createdAt: '2026-09-25T10:00:00.000Z',
  } as unknown as ReviewRequest;
  const standing = (rounds: Omit<Parameters<typeof reviewSections>[0], 'earlier'>) =>
    facts(reviewSections({ ...rounds, earlier: [] })[0]).Standing;
  assert.deepEqual(standing({ current, gate: 'Results' }), ['Results · ', 'unclaimed']);
  const started = { ...current, status: 'started', reviewerId: 'actor_reviewer' } as ReviewRequest;
  assert.deepEqual(
    standing({ current: started, gate: 'Results', claim: { at: current.createdAt, agent: true } }),
    ['Results · ', { actor: 'actor_reviewer', prefix: 'with ', unnamed: 'with an agent' }],
  );
  assert.deepEqual(standing({ current: { ...started, reviewerId: null }, gate: 'Design' }), [
    'Design · ',
    'claimed',
  ]);
  assert.deepEqual(
    standing({ current: { ...current, status: 'submitted', verdict: 'fail' }, gate: 'Design' }),
    ['Design · ', { state: 'fail' }],
  );
  const [, earlier] = reviewSections({
    current,
    gate: 'Results',
    earlier: [
      {
        id: 'review_b',
        status: 'submitted',
        verdict: 'pass',
        createdAt: current.createdAt,
        gate: 'Design',
      },
      {
        id: 'review_a',
        status: 'superseded',
        verdict: null,
        createdAt: current.createdAt,
        gate: 'Design',
      },
      {
        id: 'review_0',
        status: 'submitted',
        verdict: 'needs_changes',
        createdAt: current.createdAt,
      },
    ],
  });
  assert.ok(earlier?.kind === 'links');
  assert.deepEqual(
    earlier.rows.map(({ name }) => name),
    ['Design · pass', 'Design · superseded', 'Needs changes'],
  );
});
