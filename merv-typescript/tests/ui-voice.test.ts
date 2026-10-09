import assert from 'node:assert/strict';
import test from 'node:test';
import { serve } from './ui-render.js';

const { sayable } = await import('../packages/ui/web/views/pi-voice.js');
const { placeOf } = await import('../packages/ui/web/views/pi-screen.js');

test('an answer written for the screen is said as words: no markup, tables or code', () => {
  assert.equal(
    sayable('## Status\n\n**Work.** Two tasks run. See [the map](/work).\n\n- one\n- two'),
    'Status Work. Two tasks run. See the map. one two',
  );
  assert.equal(
    sayable('Here it is.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```py\nprint(1)\n```\nDone.'),
    'Here it is. Done. (Details are on screen.)',
  );
  const long = sayable(`${'A sentence that goes on. '.repeat(120)}`);
  assert.ok(long.length <= 1_800, 'one append is at most 500 tokens');
  assert.ok(long.endsWith('.'), 'cut at the end of a sentence');
});

test('what the agent shows opens where a link to it would: a page by its name, a record by its id', async () => {
  const rows = [
    { id: 'work', label: 'Work', path: '/work', view: { kind: 'work' } },
    { id: 'artifacts', label: 'Files', path: '/artifacts', view: { kind: 'artifacts' } },
    { id: 'tasks', label: 'Tasks', path: '/tasks', view: { kind: 'tasks' }, workflow: 'task' },
  ] as unknown as Parameters<typeof placeOf>[1];
  assert.deepEqual(await placeOf({ page: 'files' }, rows), { path: '/artifacts', title: 'Files' });
  assert.deepEqual(await placeOf({ page: '/work' }, rows), { path: '/work', title: 'Work' });
  assert.match(
    String(await placeOf({ page: 'Billing' }, rows)),
    /no page called "Billing".*Work, Files, Tasks/,
  );
  serve('/tools/project.references', (_, sent) => ({
    body: {
      result: (sent.refs as string[]).map((ref) =>
        ref === 'art_1'
          ? { ref, id: ref, status: 'resolved', kind: 'artifact', label: 'Results.md' }
          : ref === 'task_1'
            ? { ref, id: ref, status: 'resolved', kind: 'task', label: 'Reproduce grokking' }
            : { ref, id: ref, status: 'missing', kind: null },
      ),
    },
  }));
  assert.deepEqual(await placeOf({ record: 'art_1' }, rows), {
    path: '/artifacts/art_1',
    title: 'Results.md',
  });
  assert.deepEqual(await placeOf({ record: 'task_1' }, rows), {
    path: '/tasks/task_1',
    title: 'Reproduce grokking',
  });
  assert.match(String(await placeOf({ record: 'gone' }, rows)), /No record "gone".*\(missing\)/);
});
