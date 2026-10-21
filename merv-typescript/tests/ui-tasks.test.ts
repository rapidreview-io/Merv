/**
 * The task page and the field that chooses records. Each test states one thing they
 * must do: say a check once with everything said about it, keep the brief open only
 * until something is delivered, and let a person choose a record by name, by
 * keyboard, without ever reading or typing an id. An earlier delivery is reached from
 * the thread (ui-thread.test.ts).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { click, mount, serve, settle, text, unmount } from './ui-render.js';

const { createElement, useState } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
await import('../packages/ui/web/components.js');
const { RecordPicker, narrowed, stepped } = await import('../packages/ui/web/record-picker.js');
const { TaskChecks } = await import('../packages/ui/web/views/tasks.js');
const { fileInput } = await import('../packages/ui/web/views/artifacts.js');
const { CreateResearch, CycleMove, chained, currentCycle } =
  await import('../packages/ui/web/views/work.js');
const { researchUiPlugin } = await import('../packages/research/src/ui.js');
const { SessionProvider } = await import('../packages/ui/web/session.js');
const { setToken } = await import('../packages/ui/web/api.js');
const all = (selector: string) => [...document.querySelectorAll(selector)];

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

/*
 * The cycle's one move, rendered against the gate the project's one read reports. It
 * must never offer a press the gate refuses, and it must be able to send every answer
 * the gate asks for: the plan's next wave, and a fresh consolidation task.
 */
const cycle = (state: string) => ({
  id: 'wf_cycle',
  projectId: 'project_1',
  ownerId: 'actor_1',
  automation: null,
  name: 'QA cycle 1',
  createdAt: new Date().toISOString(),
  researchDependencies: ['wf_task', 'wf_done'],
  progress: { settled: 1, total: 2 },
  workflow: { workflow: 'research', state, revision: 3, updatedAt: new Date().toISOString() },
  problem: null,
  reflectionId: null,
  integrations: [],
  origin: null,
  successorId: null,
});
const dependency = (id: string, name: string, state: string, settled: boolean) => ({
  id,
  workflow: 'task',
  version: 5,
  name,
  state,
  settled,
  failed: false,
});
/** The cycle's gate, as `workflow.status_and_next` reports it. */
const cycleGate = (state: string, advance: Record<string, unknown>) => ({
  body: {
    result: {
      instanceId: 'wf_cycle',
      workflow: 'research',
      version: 4,
      state,
      revision: 3,
      actions: [
        {
          action: `advance_${state}`,
          // As guidance names the noun to a person, its arguments under the action.
          tool: 'research.write',
          instruction: 'Advance the cycle.',
          arguments: {
            action: 'advance',
            advance: { researchId: 'wf_cycle', expectedRevision: 3 },
          },
          requiredInput: [],
          blockers: [],
          ...advance,
        },
      ],
      dependencies: [
        dependency('wf_task', 'Sweep weight decay', 'in_progress', false),
        dependency('wf_done', 'Baseline run', 'done', true),
      ],
    },
  },
});
const sent: Record<string, unknown>[] = [];
/** The Cycles row as Research registers it: the choices a gate asks for are named there. */
const cyclesRow = (() => {
  const rows: { id: string; path: string; view: { kind: string } }[] = [];
  researchUiPlugin.apply({
    research: {},
    effect: (register: () => unknown) => register(),
    ui: { register: (row: (typeof rows)[number]) => rows.push(row) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const { id, path, view } = rows.find((row) => row.view.kind === 'research')!;
  return { id, path, view };
})();
const researchShape = {
  name: 'research',
  version: 1,
  initial: 'researching',
  states: ['researching', 'consolidating', 'reflecting', 'complete', 'abandoned'],
  terminal: ['complete', 'abandoned'],
  edges: [],
};
const page = (state: string, rows: unknown[] = [cyclesRow]) => {
  sent.length = 0;
  serve('/tools/research.write:advance', (_call, body) => {
    sent.push(body);
    return { body: { result: { ...cycle(state), revision: 4 } } };
  });
  return createElement(
    MemoryRouter,
    null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createElement(CycleMove as any, {
      cycle: cycle(state),
      // The deployed shape says where a cycle ends; the page knows no end state of its own.
      shell: { rows, plugins: [], workflows: [researchShape] },
      onSaved() {},
    }),
  );
};
const buttons = () =>
  [...document.querySelectorAll('button')].map((button) => [button.textContent, button.disabled]);

test('a move the gate refuses is not offered, and what it waits on is named with its state', async (t) => {
  t.after(unmount);
  serve(
    '/tools/workflow.read:status',
    cycleGate('researching', {
      status: 'blocked',
      blockers: [
        {
          code: 'dependencies_pending',
          status: 409,
          message: 'Waiting for research outcomes: Sweep weight decay (in_progress)',
        },
      ],
    }),
  );
  await mount(page('researching'));
  await settle(10);
  assert.deepEqual(buttons(), [['Start next step', true]]);
  const shown = text();
  assert.ok(shown.includes('Sweep weight decay'), shown);
  assert.ok(shown.includes('in progress'), shown);
  assert.ok(!shown.includes('Baseline run'), 'a settled prerequisite holds nothing up');
  assert.ok(!shown.includes('Waiting for'), 'the refusal is data, not the server’s sentence');
});

test('a ready gate is the one move, and it sends nothing it was not asked for', async (t) => {
  t.after(unmount);
  serve('/tools/workflow.read:status', cycleGate('researching', { status: 'ready' }));
  await mount(page('researching'));
  await settle(10);
  assert.deepEqual(buttons(), [['Start next step', false]]);
  assert.ok(!text().includes('Sweep weight decay'), 'nothing is waited on while the move is open');
  await click('Start next step');
  assert.deepEqual(Object.keys(sent[0]!).sort(), ['expectedRevision', 'requestId', 'researchId']);
});

test('a cycle that has ended offers no move at all', async (t) => {
  t.after(unmount);
  for (const state of ['complete', 'abandoned']) {
    await mount(page(state));
    await settle(10);
    assert.deepEqual(buttons(), [], state);
    await unmount();
  }
});
