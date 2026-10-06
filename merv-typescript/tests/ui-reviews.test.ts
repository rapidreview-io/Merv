/**
 * The verdict desk. A rejection goes where its reviewer sends it: every route the owning
 * domain accepts is offered on the desk, and only those.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { click, mount, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { MemoryRouter, Routes, Route } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
await import('../packages/ui/web/components.js');
const { ReviewDetail } = await import('../packages/ui/web/views/reviews.js');
const { SessionProvider } = await import('../packages/ui/web/session.js');

const REPORT = 'art_00000000000000000000000000000001';
const claimed = {
  id: 'review_1',
  subjectId: 'wf_wave',
  subjectRevision: 7,
  artifactIds: [REPORT],
  criteria: ['The synthesis reconciles the lenses.'],
  formatVersion: 2,
  status: 'started',
  reviewerId: 'actor_b',
  claimId: 'claim_1',
  verdict: null,
  notes: null,
  synopsis: null,
  findings: [],
  createdAt: new Date().toISOString(),
};
const desk = (workflow: string, state: string) => ({
  instanceId: 'wf_wave',
  workflow,
  version: 3,
  state,
  revision: 7,
  label: 'Wave',
  terminal: false,
  available: true,
  currentGate: state,
  nextAction: null,
  instruction: '',
  actions: [
    {
      action: 'submit_review',
      tool: 'review.submit',
      status: 'needs_input',
      arguments: { reviewId: 'review_1', claimId: 'claim_1', expectedRevision: 7 },
      blockers: [],
      instruction: '',
    },
  ],
  blockers: [],
  providerBlockers: [],
  references: [],
  dependencies: [],
  limits: [],
  workStart: null,
});
const project = { id: 'project_1', name: 'Grokking', createdAt: '2026-09-01T00:00:00Z' };
const actor = { id: 'actor_b', projectId: project.id, name: 'Reviewer', role: 'reviewer' };
const page = () => {
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', {
    body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] },
  });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows: [], plugins: [] } } });
  return createElement(
    MemoryRouter,
    { initialEntries: ['/reviews/review_1'] },
    createElement(
      SessionProvider,
      null,
      createElement(
        Routes,
        null,
        createElement(Route, { path: '/reviews/:id', element: createElement(ReviewDetail) }),
      ),
    ),
  );
};
const write = async (field: HTMLTextAreaElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!;
  await act(async () => {
    set.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await settle(0);
};
/** Answer the one criterion and the synopsis, then choose a rejection. */
const reject = async () => {
  await click('not met');
  await write(
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes on check 1"]')!,
    'The methods disagreement is not resolved.',
  );
  await write(
    [...document.querySelectorAll('label')]
      .find((label) => label.textContent?.startsWith('Synopsis'))!
      .querySelector('textarea')!,
    'The synthesis reconciles the lenses but does not say how the methods disagreement was resolved.',
  );
  await click('needs changes');
};

/** The desk of one gate, answered and rejected: the routes it offers, and what it sends. */
const rejected = async (workflow: string, state: string) => {
  const submitted: { body?: Record<string, unknown> } = {};
  serve('/tools/review.get', { body: { result: claimed } });
  serve('/tools/workflow.status_and_next', { body: { result: desk(workflow, state) } });
  serve('/tools/review.submit', (_, body) => {
    submitted.body = body;
    return { body: { result: { id: 'review_1' } } };
  });
  await mount(page());
  await settle(10);
  await reject();
  const routes = [...document.querySelectorAll('button[aria-pressed]')]
    .map((button) => button.textContent)
    .filter((label) => label?.includes(','));
  return { routes, submitted };
};

test('a reflection rejection is sent back to synthesis or to five new lenses, as its reviewer chooses', async (t) => {
  t.after(async () => await unmount());
  const { routes, submitted } = await rejected('reflection', 'in_review');
  assert.deepEqual(routes, ['Synthesis, for a revised report', 'Lenses, for five new reports']);
  assert.ok(text().includes('Choose where the work returns.'), 'no route is chosen for them');
  await click('Lenses, for five new reports');
  await click('Submit verdict');
  assert.equal(submitted.body?.returnTo, 'reflecting');
  assert.equal(submitted.body?.verdict, 'needs_changes');
});

test('an experiment results rejection keeps its own two routes', async (t) => {
  t.after(async () => await unmount());
  const { routes } = await rejected('experiment', 'experiment_review');
  assert.deepEqual(routes, [
    'Planning, for a new design and attempt',
    'Running, to repair under the approved plan',
  ]);
});

test('a task review offers no return route, because its domain takes none', async (t) => {
  t.after(async () => await unmount());
  const { routes, submitted } = await rejected('task', 'in_review');
  assert.deepEqual(routes, []);
  assert.ok(!text().includes('Returns to'));
  await click('Submit verdict');
  assert.equal(submitted.body?.verdict, 'needs_changes');
  assert.equal('returnTo' in (submitted.body ?? {}), false);
});

test('a Git task review is passed from a browser only by its owner deciding as owner', async (t) => {
  t.after(async () => await unmount());
  const verdicts = async (review: Record<string, unknown>, workflow = 'task') => {
    serve('/tools/review.get', { body: { result: review } });
    serve('/tools/workflow.status_and_next', {
      body: { result: desk(workflow, workflow === 'task' ? 'in_review' : 'experiment_review') },
    });
    await mount(page());
    await settle(10);
    const words = [...document.querySelectorAll('.entry-form .crit-pick')].map(
      (button) => button.textContent,
    );
    await unmount();
    return words;
  };
  // Only a leased reviewer in a checkout of the delivered commit passes it otherwise.
  assert.deepEqual(await verdicts(claimed), ['needs changes', 'fail']);
  assert.deepEqual(await verdicts({ ...claimed, override: true }), [
    'pass',
    'needs changes',
    'fail',
  ]);
  assert.deepEqual(await verdicts(claimed, 'experiment'), ['pass', 'needs changes', 'fail']);
});

test('a Git task review nobody interactive can pass offers no claim, and says what holds it', async (t) => {
  t.after(async () => await unmount());
  const refusal =
    'Only a leased review worker, in a checkout of the delivered commit, can pass a Git task';
  const blocked = (action: string, tool: string, code: string, message: string) => ({
    action,
    tool,
    status: 'blocked',
    arguments: {},
    blockers: [{ code, message }],
    instruction: '',
  });
  serve('/tools/review.get', {
    body: { result: { ...claimed, status: 'requested', reviewerId: null, claimId: null } },
  });
  serve('/tools/workflow.status_and_next', {
    body: {
      result: {
        ...desk('task', 'in_review'),
        actions: [
          blocked(
            'submit_review',
            'review.submit',
            'review_closed',
            'Review must be claimed first',
          ),
          blocked('start_review', 'review.start', 'leased_review_required', refusal),
        ],
      },
    },
  });
  await mount(page());
  await settle(10);
  assert.ok(!text().includes('Claim review'));
  assert.ok(!text().includes('Decide as owner'), 'only the owner is offered the override');
  assert.ok(text().includes(refusal));
});

test('an owner the default leaves out decides the review as owner, with one control', async (t) => {
  t.after(async () => await unmount());
  const refusal = 'A producer, contributor or directing authority cannot review their own work';
  const claims: unknown[] = [];
  const requested = { ...claimed, status: 'requested', reviewerId: null, claimId: null };
  serve('/tools/review.get', { body: { result: { ...requested, overridable: true } } });
  serve('/tools/workflow.status_and_next', {
    body: {
      result: {
        ...desk('task', 'in_review'),
        actions: [
          {
            action: 'start_review',
            tool: 'review.start',
            status: 'blocked',
            arguments: {},
            blockers: [{ code: 'review_independence', message: refusal }],
            instruction: '',
          },
        ],
      },
    },
  });
  serve('/tools/review.start', (_, body) => {
    claims.push(body);
    return { body: { result: { ...claimed, override: true } } };
  });
  await mount(page());
  await settle(10);
  assert.deepEqual(
    [...document.querySelectorAll('button')].map((button) => button.textContent),
    ['Decide as owner'],
  );
  assert.ok(!text().includes(refusal));
  await click('Decide as owner');
  assert.deepEqual(claims, [{ reviewId: 'review_1', override: true }]);
  await unmount();

  // A claim held back for another reason is not lifted by deciding as owner.
  const taken = 'Review is already claimed or closed';
  serve('/tools/workflow.status_and_next', {
    body: {
      result: {
        ...desk('task', 'in_review'),
        actions: [
          {
            action: 'start_review',
            tool: 'review.start',
            status: 'blocked',
            arguments: {},
            blockers: [{ code: 'review_unavailable', message: taken }],
            instruction: '',
          },
        ],
      },
    },
  });
  await mount(page());
  await settle(10);
  assert.ok(!text().includes('Decide as owner'));
  assert.ok(text().includes(taken));
});

test('a decided review leads with what it found short and its sentence; the checks follow', async (t) => {
  t.after(async () => await unmount());
  const findings = ['met', 'not_met', 'not_verified', 'waived'];
  serve('/tools/review.get', {
    body: {
      result: {
        ...claimed,
        criteria: ['First check.', 'Second check.', 'Third check.', 'Fourth check.'],
        status: 'submitted',
        verdict: 'needs_changes',
        returnTo: 'planned',
        synopsis: 'The design names no matched control run.',
        findings: findings.map((status, index) => ({
          criterionNumber: index + 1,
          status,
          evidenceIds: [],
          notes: `Finding ${index + 1}.`,
        })),
      },
    },
  });
  await mount(page());
  await settle(10);
  const said = text();
  const order = [
    '2 of 4 not met',
    'The design names no matched control run.',
    'Returned to planned',
    'Check 4 was waived.',
    'Check 3 was not verified.',
    'Checks',
    'First check.',
  ].map((line) => [line, said.indexOf(line)] as const);
  assert.ok(
    order.every(([, at]) => at >= 0),
    `every line is on the page: ${said}`,
  );
  assert.deepEqual(
    order.map(([line]) => line),
    [...order].sort((a, b) => a[1] - b[1]).map(([line]) => line),
  );
  assert.equal(said.split('The design names no matched control run.').length, 2, 'said once');
  assert.ok(
    ![...document.querySelectorAll('.ev-role')].some((label) => label.textContent === 'Verdict'),
    'no block after the checks repeats it',
  );
});

test('a verdict the owner gave as owner says so where it says who gave it', async (t) => {
  t.after(async () => await unmount());
  serve('/tools/review.get', {
    body: {
      result: {
        ...claimed,
        status: 'submitted',
        verdict: 'pass',
        synopsis: 'Done.',
        override: true,
      },
    },
  });
  await mount(page());
  await settle(10);
  assert.match(text(), /reviewed( by \S+)? as owner/);
});

test('a review is named by what it judges, a reflection too, and the name leads back to it', async (t) => {
  t.after(async () => await unmount());
  serve('/tools/review.get', { body: { result: claimed } });
  serve('/tools/workflow.status_and_next', { body: { result: desk('reflection', 'in_review') } });
  const reflections = { id: 'reflections', path: '/reflections', view: { kind: 'reflections' } };
  const element = page();
  serve('/tools/ui.shell', {
    body: {
      result: {
        actor,
        project,
        rows: [
          {
            ...reflections,
            label: 'Reflections',
            group: 'work',
            order: 1,
            status: {},
            readable: true,
          },
        ],
        plugins: [],
      },
    },
  });
  serve('/tools/ui.home', {
    body: { result: { reflections: [{ id: 'wf_wave', title: 'Wave one', ownerId: 'actor_a' }] } },
  });
  await mount(element);
  await settle(10);
  const name = document.querySelector<HTMLAnchorElement>('h1 a, .record-name a');
  assert.equal(name?.textContent, 'Wave one');
  assert.equal(name?.getAttribute('href'), '/reflections/wf_wave');
});

test('a check the review requires is met to pass, never waived, as review.submit decides', async (t) => {
  t.after(async () => await unmount());
  serve('/tools/review.get', { body: { result: { ...claimed, requiredCriteria: [1] } } });
  serve('/tools/workflow.status_and_next', {
    body: { result: desk('experiment', 'design_review') },
  });
  await mount(page());
  await settle(10);
  await click('waived');
  await write(
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes on check 1"]')!,
    'Feasibility is out of scope for this design.',
  );
  await write(
    [...document.querySelectorAll('label')]
      .find((label) => label.textContent?.startsWith('Synopsis'))!
      .querySelector('textarea')!,
    'The design is sound, and feasibility was waived as out of scope for this first round.',
  );
  const pass = [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
    (button) => button.textContent === 'pass',
  )!;
  await act(async () => pass.click());
  await settle(0);
  const submit = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Submit verdict',
  )!;
  assert.equal(submit.disabled, true);
  assert.match(text(), /Check 1 is required: a passing verdict needs it met, not waived\./);
});

test('a draft belongs to its review: opening the next review starts it blank', async (t) => {
  t.after(async () => await unmount());
  const { useNavigate } = await import('react-router-dom');
  serve('/tools/review.get', (_, sent) => ({
    body: { result: { ...claimed, id: sent.reviewId } },
  }));
  serve('/tools/workflow.status_and_next', { body: { result: desk('task', 'in_review') } });
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', {
    body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] },
  });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows: [], plugins: [] } } });
  let go: (to: string) => void = () => {};
  const Steer = () => {
    go = useNavigate();
    return null;
  };
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/reviews/review_1'] },
      createElement(
        SessionProvider,
        null,
        createElement(Steer),
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/reviews/:id', element: createElement(ReviewDetail) }),
        ),
      ),
    ),
  );
  await settle(10);
  const notes = () =>
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes on check 1"]');
  await click('not met');
  await write(notes()!, 'Only true of the first review.');
  assert.equal(notes()!.value, 'Only true of the first review.');
  await act(async () => go('/reviews/review_2'));
  await settle(10);
  assert.ok(!text().includes('Only true of the first review.'));
  assert.ok(!notes() || notes()!.value === '', notes()?.value);
});
