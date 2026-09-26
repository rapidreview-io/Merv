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
import type { RunningRead } from '@merv/ui';
import { reviewSections } from '@merv/reviews/running';
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
    Standing: ['Unclaimed', ' · ', open(requested.id)],
    Requested: [{ ago: requested.createdAt }],
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
      Standing: [
        { actor: reviewer.caller.actorId, prefix: 'With ', unnamed: 'Claimed' },
        ' · ',
        open(requested.id),
      ],
      Requested: [{ ago: requested.createdAt }],
      'Claimed for': [{ since: started.createdAt }],
    });

  // The verdict that sent the work back stays while the producer is on it again.
  const returned = await f.app.ctx.tasks.submitReview(reviewer.caller, f.sendBack(claimed, first));
  assert.equal(returned.workflow.state, 'in_progress');
  assert.deepEqual(facts((await f.sections(f.operator, first.id))[0]), {
    Standing: [{ state: 'needs_changes' }, ' · ', open(requested.id)],
    Requested: [{ ago: requested.createdAt }],
    Verdict: ['Negative inputs produce the wrong sign.'],
    Checks: [{ count: 1, of: 2 }, ' not met'],
  });

  // Each new delivery is a new round; the ones before it are one line each, newest first.
  const second = await f.deliver(returned);
  const again = await f.app.ctx.reviews.get(f.operator, second.reviewId!);
  const reread = await f.sections(f.operator, first.id);
  assert.deepEqual(facts(titled(reread, 'Review')).Standing, ['Unclaimed', ' · ', open(again.id)]);
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
  assert.deepEqual(facts(titled(latest, 'Review')).Standing, [
    'Unclaimed',
    ' · ',
    open(third.reviewId!),
  ]);
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

test('why nobody can take a review is said to an operator alone, and another project reads nothing of it', async (t) => {
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

  const [held] = await f.sections(f.operator, 'subject');
  assert.equal(held.attention, true);
  assert.ok(held.kind === 'facts');
  assert.deepEqual(held.rows, [
    { label: 'Standing', value: ['Unclaimed', ' · ', open(review.id)] },
    {
      label: 'No reviewer',
      value: ['Every eligible reviewer contributed to this work · An operator provides one'],
      attention: true,
    },
    { label: 'Requested', value: [{ ago: review.createdAt }] },
  ]);
  const [read] = await f.sections(f.reader.caller, 'subject');
  assert.equal(read.attention, undefined);
  assert.deepEqual(Object.keys(facts(read)), ['Standing', 'Requested']);

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
    ' · ',
    open(delivered.reviewId!),
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
    Standing: [{ state: 'pass' }, ' · ', open('review_current')],
    Requested: [{ ago: base.createdAt }],
    Verdict: ['Both waivers are recorded with their reasons.'],
    Checks: [{ count: 2, of: 3 }, ' waived'],
  });
  assert.ok(earlier.kind === 'links');
  assert.equal(earlier.rows[0].name, 'Superseded');
  // A claim whose event is gone still stands, without a clock.
  const [claimed] = reviewSections({
    current: { ...base, status: 'started', verdict: null, findings: [] },
    earlier: [],
  });
  assert.deepEqual(facts(claimed), {
    Standing: [
      { actor: 'actor_reviewer', prefix: 'With ', unnamed: 'Claimed' },
      ' · ',
      open('review_current'),
    ],
    Requested: [{ ago: base.createdAt }],
  });
});
