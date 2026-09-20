/**
 * The task page and the field that chooses records. Each test states one thing they
 * must do: say a check once with everything said about it, keep the brief open only
 * until something is delivered, keep an earlier delivery reachable, let a producer
 * deliver from the page alone — a file from their own disk included — and let a person
 * choose a record by name, by keyboard, without ever reading or typing an id.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, serve, settle, text, unmount } from './ui-render.js';

const { createElement, useState } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
await import('../packages/ui/web/components.js');
const { RecordPicker, narrowed, stepped } = await import('../packages/ui/web/record-picker.js');
const { TaskChecks, useDelivery } = await import('../packages/ui/web/views/tasks.js');
const { fileInput } = await import('../packages/ui/web/views/artifacts.js');
const { Gate } = await import('../packages/ui/web/process.js');
const { CreateResearch } = await import('../packages/ui/web/views/work.js');
const { CreateConsolidation, outputsOf } =
  await import('../packages/ui/web/views/research-programs.js');

const BRIEF = 'art_00000000000000000000000000000001';
const DELIVERY = 'art_00000000000000000000000000000002';
const CLAIMS = 'art_00000000000000000000000000000003';
const FIRST_TRY = 'art_00000000000000000000000000000004';
const file = (id: string, title: string) => ({
  id,
  projectId: 'project_1',
  createdBy: 'actor_1',
  title,
  mediaType: 'text/markdown',
  hash: 'abc',
  size: 259,
  createdAt: new Date().toISOString(),
});
const CHECKS = ['Train accuracy 100% before step 2k', 'Curve and seed attached'];
const task = (over: Record<string, unknown> = {}) => ({
  id: 'wf_task',
  title: 'Reproduce grokking',
  goal: 'Show the curve.',
  checks: CHECKS,
  deliveryConfirmations: [],
  producerId: 'actor_1',
  briefId: BRIEF,
  deliveryIds: [],
  reviewId: null,
  workflow: { state: 'in_progress', revision: 1, updatedAt: new Date().toISOString() },
  failure: null,
  dependencies: [],
  dependents: [],
  createdAt: new Date().toISOString(),
  ...over,
});
const review = (over: Record<string, unknown> = {}) => ({
  id: 'review_now',
  subjectId: 'wf_task',
  subjectRevision: 4,
  artifactIds: [BRIEF, DELIVERY, CLAIMS],
  criteria: CHECKS,
  formatVersion: 2,
  status: 'submitted',
  reviewerId: 'actor_2',
  claimId: null,
  verdict: 'pass',
  notes: null,
  synopsis: 'Both thresholds are reported and the curve is retained.',
  findings: [
    {
      criterionNumber: 1,
      status: 'met',
      evidenceIds: [DELIVERY],
      notes: 'The report records 100% at step 1,640.',
    },
    {
      criterionNumber: 2,
      status: 'not_verified',
      evidenceIds: [DELIVERY],
      notes: 'The seed is named; the figure was not opened.',
    },
  ],
  createdAt: new Date().toISOString(),
  ...over,
});
const loaded = (data?: unknown[]) => ({
  data,
  error: undefined,
  loadedAt: undefined,
  loading: false,
  reload() {},
});
const checksPage = (t: unknown, reviews?: unknown[]) =>
  createElement(
    MemoryRouter,
    null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createElement(TaskChecks as any, { task: t, reviews: loaded(reviews) }),
  );
const times = (needle: string) => text().split(needle).length - 1;
const all = (selector: string) => [...document.querySelectorAll(selector)];

test('before a delivery a row is the check alone, and a brief somebody wrote is open to read', async (t) => {
  t.after(async () => await unmount());
  serve('/tools/artifact.list', { body: { result: [file(BRIEF, 'Brief: reproduce grokking')] } });
  serve('/tools/artifact.read', {
    body: {
      result: { artifact: file(BRIEF, 'Brief'), encoding: 'utf8', content: '# Goal\nShow it.' },
    },
  });
  await mount(checksPage(task()));
  await settle(10);
  assert.deepEqual(
    all('.crit-text').map((node) => node.textContent),
    CHECKS,
  );
  assert.equal(all('.crit-says').length, 0, 'nobody has said anything about a check yet');
  const brief = document.querySelector<HTMLDetailsElement>('details.crit-file')!;
  assert.ok(brief.open, 'the brief is what there is to read');
  assert.equal(document.querySelector('.md h3')?.textContent, 'Goal');
  // The disclosure has said the file's title, so the head it opens says the type instead
  // and keeps the way to the file's own page as a named glyph.
  assert.equal(times('Brief: reproduce grokking'), 1, 'the title is said once');
  assert.equal(brief.querySelector('.doc-name')!.textContent, 'Markdown');
  const way = brief.querySelector<HTMLAnchorElement>('.doc-tools a.btn-icon')!;
  assert.deepEqual(
    [way.getAttribute('href'), way.getAttribute('aria-label'), way.title],
    [`/artifacts/${BRIEF}`, 'Open Brief: reproduce grokking', 'Open file'],
  );
});

test('the brief the server composed stays shut: the page has already said all of it', async (t) => {
  t.after(async () => await unmount());
  // A file of its own: the list another test left in the api's memory does not name it.
  const composed = 'art_00000000000000000000000000000009';
  serve('/tools/artifact.list', {
    body: { result: [file(composed, 'Task brief: Reproduce grokking')] },
  });
  await mount(checksPage(task({ briefId: composed })));
  await settle(10);
  const brief = document.querySelector<HTMLDetailsElement>('details.crit-file')!;
  assert.ok(!brief.open, 'its title, goal and checks are the header and the rows above it');
  // The page's title is the composed brief's too, so the fold names its part instead.
  assert.match(brief.querySelector('summary')!.textContent!, /^Brief Markdown/);
  assert.equal(times('Reproduce grokking'), 0, 'and the title is not said a second time here');
});

test('a reviewed task says each check once, with the claim, the finding and the file they cite', async (t) => {
  t.after(async () => await unmount());
  serve('/tools/artifact.list', {
    body: {
      result: [
        file(BRIEF, 'Brief: reproduce grokking'),
        file(DELIVERY, 'Delivery: grokking curve'),
        file(CLAIMS, 'Delivery confirmations'),
        file(FIRST_TRY, 'Delivery: first try'),
      ],
    },
  });
  const delivered = task({
    deliveryIds: [DELIVERY, CLAIMS],
    reviewId: 'review_now',
    workflow: { state: 'done', revision: 5, updatedAt: new Date().toISOString() },
    deliveryConfirmations: [
      {
        checkNumber: 1,
        status: 'met',
        evidenceIds: [DELIVERY],
        notes: 'Reached 100% at step 1,640.',
      },
      { checkNumber: 2, status: 'not_met', evidenceIds: [], notes: 'The figure is still missing.' },
    ],
  });
  const earlier = review({
    id: 'review_before',
    subjectRevision: 2,
    artifactIds: [BRIEF, FIRST_TRY],
    verdict: 'needs_changes',
    synopsis: 'The first delivery reports no seed.',
    findings: [],
  });
  const elsewhere = review({ id: 'review_other', subjectId: 'wf_other' });
  await mount(checksPage(delivered, [earlier, review(), elsewhere]));

  for (const said of [
    ...CHECKS,
    'Reached 100% at step 1,640.',
    'The report records 100% at step 1,640.',
    'Both thresholds are reported and the curve is retained.',
    'Open the review',
  ])
    assert.equal(times(said), 1, `“${said}” is on the page once`);

  // Reading order inside a row: the check, the producer's claim, the reviewer's finding.
  const [first, second] = all('.crit');
  assert.deepEqual(
    [...first!.querySelectorAll('.crit-says dt, .crit-pill')].map((node) => node.textContent),
    ['Producer', 'met', 'Reviewer', 'met'],
  );
  assert.deepEqual(
    [...second!.querySelectorAll('.crit-pill')].map((node) => node.className),
    ['crit-word crit-pill crit-word--not_met', 'crit-word crit-pill crit-word--not_verified'],
  );
  // Both cite the same file; the row opens it once.
  assert.equal(first!.querySelectorAll('details.crit-file').length, 1);

  // The documents fold away by name, all shut: the rows above already say what they say.
  const files = all('.ev-role ~ details.crit-file') as HTMLDetailsElement[];
  // What a shut file would open stands after its title as one piece of its own.
  const titled = (node: Element) => {
    const summary = node.querySelector('summary')!;
    const meta = summary.querySelector('.crit-file-meta')?.textContent ?? '';
    return summary.textContent!.replace(meta, '').trim();
  };
  assert.equal(files[0]!.querySelector('.crit-file-meta')!.textContent, 'Markdown · 259 B');
  assert.deepEqual(
    files.map((node) => [titled(node), node.open]),
    [
      ['Brief: reproduce grokking', false],
      ['Delivery: grokking curve', false],
      ['Delivery confirmations', false],
      ['Earlier deliveries 1', false],
    ],
  );
  // The earlier round is the way to its own verdict and still opens what it pinned.
  const round = files[3]!;
  assert.equal(round.querySelector('a')?.getAttribute('href'), '/reviews/review_before');
  assert.equal(round.querySelector('.crit-pill')?.textContent, 'needs changes');
  assert.match(round.querySelectorAll('summary')[1]!.textContent!, /^Delivery: first try/);
  assert.ok(!text().includes('review_other'), 'another record’s review is not this task’s');
  assert.doesNotMatch(text(), /art_0|wf_task/, 'no identifier is printed');
});

/** A task whose gate says this reader may deliver: the edge the diagram draws carries it. */
const node = (state: string, over: Record<string, unknown> = {}) => ({
  state,
  initial: false,
  terminal: false,
  current: false,
  entries: 0,
  firstEnteredAt: null,
  blockers: [],
  ...over,
});
const deliverable = {
  instanceId: 'wf_task',
  workflow: 'task',
  version: 2,
  revision: 1,
  state: 'in_progress',
  currentGate: 'delivery_required',
  terminal: false,
  nodes: [
    node('in_progress', { initial: true, current: true }),
    node('in_review'),
    node('done', { terminal: true }),
  ],
  edges: [
    {
      from: 'in_progress',
      action: 'submit_delivery',
      to: 'in_review',
      traversals: [],
      // Whether this reader may deliver is the gate's answer, carried on the edge.
      status: 'needs_input',
      tool: 'task.submit_delivery',
      blockers: [],
    },
    {
      from: 'in_review',
      action: 'pass',
      to: 'done',
      traversals: [],
      status: null,
      tool: null,
      blockers: [],
    },
  ],
  dependencies: [],
};

test('the producer delivers at a desk on the task’s own page, by the tool’s own rules', async (t) => {
  t.after(async () => await unmount());
  const composed = 'art_00000000000000000000000000000008';
  serve('/tools/artifact.list', {
    body: {
      result: [
        file(composed, 'Task brief: Reproduce grokking'),
        file(DELIVERY, 'Delivery: grokking curve'),
      ],
    },
  });
  let sent: Record<string, unknown> | undefined;
  serve('/tools/task.submit_delivery', (_call, body) => {
    sent = body;
    return { body: { result: task({ briefId: composed }) } };
  });
  // The page as the task's own route draws it: the desk by the diagram, its rows under it.
  function Page() {
    const held = task({ briefId: composed, evidenceVersion: 2 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delivery = useDelivery(held as any, deliverable as any, () => {});
    return createElement(
      'div',
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(Gate as any, { graph: deliverable, kind: 'tasks' }, delivery.desk),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(TaskChecks as any, { task: held, reviews: loaded(), draft: delivery.draft }),
    );
  }
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/tasks/wf_task#deliver'] },
      createElement(Page),
    ),
  );
  await settle(20);
  const search = document.querySelector<HTMLInputElement>('#deliver input[role="combobox"]')!;
  assert.equal(document.activeElement, search, 'arriving from Now, the cursor is at the desk');
  const submit = () =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Submit delivery',
    )!;
  assert.ok(submit().disabled);
  assert.ok(text().includes('Choose the files that carry the work.'));

  const press = async (name: string) => {
    await act(async () => {
      search.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      );
    });
  };
  await press('ArrowDown');
  assert.deepEqual(
    all('[role="option"]').map((option) => option.textContent),
    ['Delivery: grokking curve'],
    'the brief is what was asked, never part of what answers it',
  );
  await press('Enter');
  await press('Escape');
  assert.ok(text().includes('Check 1 still needs your word and a note.'));

  // Each row is where the producer writes: the word, the sentence, the file that shows it.
  const rows = all('.crit');
  const words = (at: number) =>
    [...rows[at]!.querySelectorAll<HTMLButtonElement>('.crit-pick')].map(
      (pick) => pick.textContent,
    );
  assert.deepEqual(words(0), ['met', 'not met'], 'a producer claims; only a reviewer waives');
  const pick = async (at: number, word: string, note: string) => {
    await act(async () =>
      [...rows[at]!.querySelectorAll<HTMLButtonElement>('.crit-pick')]
        .find((button) => button.textContent === word)!
        .click(),
    );
    const notes = rows[at]!.querySelector('textarea')!;
    const set = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      set.call(notes, note);
      notes.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  await pick(0, 'met', 'Reached 100% at step 1,640.');
  await pick(1, 'not met', 'The figure is still missing.');
  assert.ok(text().includes('Check 1 is met, so it must cite a delivered file.'));
  await act(async () =>
    rows[0]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  assert.ok(!submit().disabled);
  await act(async () => submit().click());
  await settle(10);
  assert.deepEqual(
    { ...sent, requestId: typeof sent?.requestId },
    {
      taskId: 'wf_task',
      artifactIds: [DELIVERY],
      confirmations: [
        {
          checkNumber: 1,
          status: 'met',
          evidenceIds: [DELIVERY],
          notes: 'Reached 100% at step 1,640.',
        },
        {
          checkNumber: 2,
          status: 'not_met',
          evidenceIds: [],
          notes: 'The figure is still missing.',
        },
      ],
      expectedRevision: 1,
      requestId: 'string',
    },
  );
  assert.doesNotMatch(text(), /art_0|wf_task/, 'no identifier is printed');
});

test('a producer with nothing retained is told so, and brings a file from their own disk', async (t) => {
  t.after(async () => await unmount());
  const composed = 'art_00000000000000000000000000000008';
  const made = 'art_00000000000000000000000000000009';
  const held = [file(composed, 'Task brief: Reproduce grokking')];
  serve('/tools/artifact.list', () => ({ body: { result: held } }));
  const created: Record<string, unknown>[] = [];
  serve('/tools/artifact.create', (_call, body) => {
    created.push(body);
    const kept = { ...file(made, String(body.title)), mediaType: String(body.mediaType) };
    held.push(kept);
    return { body: { result: kept } };
  });
  function Page() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delivery = useDelivery(
      task({ briefId: composed, evidenceVersion: 2 }) as any,
      deliverable as any,
      () => {},
    );
    return createElement('div', null, delivery.desk);
  }
  await mount(createElement(MemoryRouter, null, createElement(Page)));
  await settle(20);
  const search = document.querySelector<HTMLInputElement>('#deliver input[role="combobox"]')!;
  await act(async () => {
    search.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
  });
  // Nothing to choose from is not a search that matched nothing, and is not said as one.
  assert.equal(document.querySelector('.picker-none')?.textContent, 'No files of yours yet');

  const bring = document.querySelector<HTMLButtonElement>(
    '#deliver button[aria-label="New file"]',
  )!;
  assert.equal(bring.title, 'New file');
  const chooser = document.querySelector<HTMLInputElement>('#deliver input[type="file"]')!;
  assert.ok(chooser.hidden && chooser.multiple);
  const choose = async (files: File[]) => {
    Object.defineProperty(chooser, 'files', { value: files, configurable: true });
    await act(async () => {
      chooser.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await settle(20);
  };
  // The browser could not type the report, so the end of its name does; nothing empty is sent.
  await choose([new File(['# Report\n'], 'report.md'), new File([], 'empty.txt')]);
  assert.deepEqual(created, [
    {
      title: 'report.md',
      content: Buffer.from('# Report\n').toString('base64'),
      encoding: 'base64',
      mediaType: 'text/markdown',
    },
  ]);
  assert.deepEqual(
    all('.picker-chip-name').map((chip) => chip.textContent),
    ['report.md'],
    'what was brought joins the delivery, by name',
  );
  assert.equal(
    document.querySelector('#deliver [role="alert"]')?.textContent,
    'empty.txt must hold between 1 byte and 2 MB.',
  );
  assert.doesNotMatch(text(), /art_0/, 'no identifier is printed');
});

test('a file from a disk is sent as its bytes, typed by the browser or by its name', async () => {
  const sent = async (parts: BlobPart[], name: string, type = '') => {
    const { content, ...rest } = await fileInput(new File(parts, name, { type }));
    return { ...rest, bytes: [...Buffer.from(content, 'base64')] };
  };
  assert.deepEqual(await sent([new Uint8Array([137, 80, 0, 255])], 'curve.png', 'image/png'), {
    title: 'curve.png',
    encoding: 'base64',
    mediaType: 'image/png',
    bytes: [137, 80, 0, 255],
  });
  assert.equal((await sent(['a,b\n'], 'runs.CSV')).mediaType, 'text/csv');
  assert.equal((await sent(['x'], 'train.log')).mediaType, 'text/plain');
  assert.equal((await sent(['x'], 'weights.bin')).mediaType, 'application/octet-stream');
  assert.equal(
    (await sent(['x'], 'notes.txt', 'Text/Plain; charset=utf-8')).mediaType,
    'text/plain',
    'a parameter is no part of the type the tool takes',
  );
  // Longer than one call's arguments may be, so the bytes are joined a stretch at a time.
  const long = new Uint8Array(100_000).map((_, at) => at % 251);
  assert.deepEqual((await sent([long], 'long.bin')).bytes, [...long]);
});

test('a search narrows by name, kind, state or pasted id, and the arrows wrap', () => {
  const options = [
    { id: 'wf_aaaa1111', name: 'Check training configuration', kind: 'tasks', state: 'done' },
    { id: 'wf_bbbb2222', name: 'Sweep weight decay', kind: 'experiments', state: 'running' },
  ];
  const ids = (query: string) => narrowed(options, query).map((option) => option.id);
  assert.deepEqual(ids(''), ['wf_aaaa1111', 'wf_bbbb2222']);
  assert.deepEqual(ids(' SWEEP '), ['wf_bbbb2222']);
  assert.deepEqual(ids('experiment'), ['wf_bbbb2222']);
  assert.deepEqual(ids('done'), ['wf_aaaa1111']);
  assert.deepEqual(ids('wf_bbbb'), ['wf_bbbb2222']);
  assert.deepEqual(ids('aaaa'), ['wf_aaaa1111'], 'the head of an id, without its prefix');
  assert.deepEqual(ids('nothing like it'), []);

  assert.equal(stepped(0, 3, 'ArrowDown'), 1);
  assert.equal(stepped(2, 3, 'ArrowDown'), 0);
  assert.equal(stepped(0, 3, 'ArrowUp'), 2);
  assert.equal(stepped(1, 3, 'Home'), 0);
  assert.equal(stepped(1, 3, 'End'), 2);
  assert.equal(stepped(0, 0, 'ArrowDown'), -1, 'an empty list has nowhere to stand');
});

test('records are chosen by name from the keyboard, and the form is handed their ids', async (t) => {
  t.after(async () => await unmount());
  const options = [
    { id: 'wf_a', name: 'Check training configuration', kind: 'tasks', state: 'in_progress' },
    { id: 'wf_b', name: 'Sweep weight decay', kind: 'tasks', state: 'done' },
    { id: 'wf_c', name: 'Grokking on modular addition', kind: 'experiments', state: 'running' },
  ];
  let chosen: string[] = [];
  function Form() {
    const [value, setValue] = useState<string[]>([]);
    chosen = value;
    return createElement(RecordPicker, {
      label: 'Research prerequisites',
      options,
      value,
      onChange: setValue,
    });
  }
  // The form this field stands in closes on Escape, from the document, as ListPage's does.
  let formClosed = 0;
  const formEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) formClosed++;
  };
  document.addEventListener('keydown', formEscape, true);
  t.after(() => document.removeEventListener('keydown', formEscape, true));

  await mount(createElement(MemoryRouter, null, createElement(Form)));
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const key = async (name: string) => {
    await act(async () => {
      input.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      );
    });
  };
  const type = async (value: string) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const listed = () => all('[role="option"]').map((node) => node.textContent);

  assert.equal(
    document.querySelector(`label[for="${input.id}"]`)?.textContent,
    'Research prerequisites',
  );
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('[role="listbox"]'), null);

  await key('ArrowDown');
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  const list = document.querySelector('[role="listbox"]')!;
  assert.equal(input.getAttribute('aria-controls'), list.id);
  assert.equal(list.getAttribute('aria-multiselectable'), 'true');
  assert.equal(listed().length, 3);
  // Kinds mix here, so an option says its kind, then its name, then how it stands.
  assert.equal(listed()[2], 'ExperimentGrokking on modular additionrunning');

  await type('sweep');
  assert.deepEqual(listed(), ['TaskSweep weight decaydone']);
  assert.equal(
    input.getAttribute('aria-activedescendant'),
    document.querySelector('[role="option"]')!.id,
  );
  await key('Enter');
  assert.deepEqual(chosen, ['wf_b']);
  assert.equal(input.value, '', 'the search clears for the next one');
  assert.equal(document.querySelector('.picker-chip-name')?.textContent, 'Sweep weight decay');
  assert.equal(
    document.querySelector('[role="option"][aria-selected="true"]')?.id,
    `${list.id.replace(/-list$/, '')}-wf_b`,
  );

  await key('End');
  await key('Enter');
  assert.deepEqual(chosen, ['wf_b', 'wf_c']);
  const remove = document.querySelector<HTMLButtonElement>('.picker-remove')!;
  assert.equal(remove.getAttribute('aria-label'), 'Remove Sweep weight decay');
  assert.ok(remove.title);

  // Escape shuts the list and is spent there: the form around it stays open.
  await key('Escape');
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal(formClosed, 0);
  await key('Escape');
  assert.equal(formClosed, 1, 'with the list shut, Escape is the form’s again');

  await key('Backspace');
  assert.deepEqual(chosen, ['wf_b'], 'Backspace on an empty search lets go of the last chip');
  await act(async () => remove.click());
  assert.deepEqual(chosen, []);
  assert.doesNotMatch(text(), /wf_/, 'no identifier is printed');
});

test('a form that has locked its fields locks the records chosen in them too', async (t) => {
  t.after(async () => await unmount());
  const options = [{ id: 'wf_a', name: 'Check training configuration', kind: 'tasks' }];
  let chosen: string[] = ['wf_a'];
  function Form() {
    const [value, setValue] = useState(chosen);
    const [locked, setLocked] = useState(false);
    chosen = value;
    // The way every form here locks: the fieldset is disabled, its fields are not told.
    return createElement(
      'form',
      null,
      createElement(
        'fieldset',
        { disabled: locked },
        createElement(RecordPicker, { label: 'Prerequisites', options, value, onChange: setValue }),
      ),
      createElement('button', { type: 'button', onClick: () => setLocked(true) }, 'Send'),
    );
  }
  await mount(createElement(MemoryRouter, null, createElement(Form)));
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const field = document.querySelector('.picker-field')!;
  const down = async () => {
    await act(async () => {
      field.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
  };
  await down();
  assert.equal(input.getAttribute('aria-expanded'), 'true', 'unlocked, the field opens its list');
  await act(async () =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Send')!
      .click(),
  );
  // The list was open as the command left: what it shows can no longer change what was sent.
  await act(async () => document.querySelector<HTMLElement>('[role="option"]')!.click());
  assert.deepEqual(chosen, ['wf_a'], 'an option pressed under a locked form changes nothing');
  await act(async () => {
    input.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await down();
  assert.equal(input.getAttribute('aria-expanded'), 'false', 'and the field does not open again');
  assert.ok(document.querySelector<HTMLButtonElement>('.picker-remove')!.matches(':disabled'));
});

test('a new cycle names its prerequisites by picking them, and the tool is sent their ids', async (t) => {
  t.after(async () => await unmount());
  const listed = (id: string, state: string) => ({ id, workflow: { state } });
  serve('/tools/task.list', {
    body: {
      result: [
        { ...listed('wf_sweep', 'in_progress'), title: 'Sweep weight decay' },
        { ...listed('wf_lost', 'failed'), title: 'A task that failed' },
      ],
    },
  });
  serve('/tools/experiment.list', {
    body: { result: [{ ...listed('wf_exp', 'abandoned'), name: 'An abandoned experiment' }] },
  });
  let sent: Record<string, unknown> | undefined;
  serve('/tools/research.create', (_call, body) => {
    sent = body;
    return { body: { result: { id: 'wf_cycle', workflow: { workflow: 'research' } } } };
  });
  let saved = 0;
  await mount(
    createElement(MemoryRouter, null, createElement(CreateResearch, { onSaved: () => saved++ })),
  );
  await settle(10);
  assert.equal(document.querySelector('textarea'), null, 'nowhere to type an id');
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  const name = document.querySelector<HTMLInputElement>('input[maxlength="200"]')!;
  const search = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  await act(async () => {
    set.call(name, 'Wave one');
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const key = async (value: string) => {
    await act(async () => {
      search.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
      );
    });
  };
  await key('ArrowDown');
  // Work that ended without succeeding could never be satisfied, so it is not offered.
  assert.deepEqual(
    all('[role="option"]').map((node) => node.textContent),
    ['Sweep weight decayin progress'],
  );
  await key('Enter');
  await key('Escape');
  await act(async () => {
    document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  });
  await settle(10);
  assert.deepEqual(sent?.dependsOn, ['wf_sweep']);
  assert.deepEqual(sent?.consolidationDependsOn, []);
  assert.equal(sent?.name, 'Wave one');
  assert.equal(saved, 1);
});

test('a new consolidation opens on what its wave hands over, by name, and sends ids', async (t) => {
  t.after(async () => await unmount());
  const REPORT = 'art_000000000000000000000000000000aa';
  const LENS = 'art_000000000000000000000000000000bb';
  const pinned = (id: string, title: string) => ({ id, title, hash: 'abc' });
  const wave = {
    id: 'wf_wave',
    title: 'First reflection',
    attempt: 1,
    createdAt: new Date().toISOString(),
    workflow: { workflow: 'reflection', state: 'approved', revision: 9 },
    experimentIds: ['wf_exp'],
    lenses: [
      {
        id: 'lens_1',
        perspective: 'evidence',
        instructions: '',
        workflow: { workflow: 'lens', state: 'complete', revision: 2 },
        producerId: null,
        artifact: pinned(LENS, 'Lens: evidence'),
      },
    ],
    report: pinned(REPORT, 'Reflection report'),
    changeSpec: null,
    review: null,
    corpus: null,
    paper: null,
  };
  // The one list no longer reaches the wave's files; the wave itself still names them.
  serve('/tools/artifact.list', { body: { result: [file(BRIEF, 'Brief: reproduce grokking')] } });
  serve('/tools/task.list', { body: { result: [] } });
  serve('/tools/experiment.list', {
    body: {
      result: [{ id: 'wf_exp', name: 'wd-sweep-grokking', workflow: { state: 'failed' } }],
    },
  });
  let sent: Record<string, unknown> | undefined;
  serve('/tools/consolidation.create', (_call, body) => {
    sent = body;
    return { body: { result: { id: 'wf_cons', workflow: { workflow: 'consolidation' } } } };
  });
  let cancelled = 0;
  await mount(
    createElement(
      MemoryRouter,
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(CreateConsolidation as any, {
        from: outputsOf(wave),
        onCreated() {},
        onCancel: () => cancelled++,
      }),
    ),
  );
  await settle(10);
  assert.equal(document.querySelector('textarea'), null, 'nowhere to type an id');
  assert.deepEqual(
    all('.picker > label').map((node) => node.textContent),
    ['Source files', 'Experiments requiring a decision', 'Prerequisites'],
  );
  // A decision may be about an experiment that failed, so that one is named too.
  assert.deepEqual(
    all('.picker-chip-name').map((node) => node.textContent),
    ['Reflection report', 'Lens: evidence', 'wd-sweep-grokking', 'First reflection'],
  );
  assert.doesNotMatch(text(), /art_0|wf_/, 'no identifier is printed');

  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  const name = document.querySelector<HTMLInputElement>('input[maxlength="200"]')!;
  await act(async () => {
    set.call(name, 'Consolidate the findings');
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  });
  await settle(10);
  assert.deepEqual(sent?.sourceArtifactIds, [REPORT, LENS]);
  assert.deepEqual(sent?.experimentIds, ['wf_exp']);
  assert.deepEqual(sent?.dependsOn, ['wf_wave']);
  assert.equal(sent?.workspace, 'none');
});
