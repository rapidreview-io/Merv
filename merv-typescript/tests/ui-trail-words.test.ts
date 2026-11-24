/**
 * merv-desktop's quiet step trail, fed by Merv: the Agent's own tool calls and an agent session's
 * steps read as plain words, one line per run of a kind, and each opens to what it answered.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import './ui-render.js';

const { said, mervKind, MERV_STEP } = await import('../packages/ui/web/panel/tool-words.js');
const { trailStep } = await import('../packages/ui/web/views/agent-live.js');
const { mervTurns } = await import('../packages/ui/web/board-app/thread-data.js');

const merv = (tool: string, action = '') => ({
  item: tool,
  kind: mervKind(tool),
  title: `${MERV_STEP}${tool}${action ? `.${action}` : ''}`,
  done: true,
  failed: false,
});

test("Merv's own tools read as what they did, never their names", () => {
  assert.equal(said(merv('screen_read')), 'Looked at your screen');
  assert.equal(said(merv('board_write', 'draw')), 'Drew on the board');
  assert.equal(said(merv('task_write', 'create')), 'Created a task');
  assert.equal(said(merv('task_read', 'list')), 'Listed the tasks');
  assert.equal(said(merv('experiment_read', 'get')), 'Read the experiment');
  assert.equal(said(merv('artifact_read', 'get')), 'Read a file');
  assert.equal(said(merv('workflow_status_and_next')), 'Checked the work');
  assert.equal(said(merv('web_read')), 'Searched the web');
  assert.equal(mervKind('task_write'), 'edit');
  assert.equal(mervKind('board_read'), 'read');
  assert.equal(mervKind('sandboxes_job'), 'run');
});

test("the Agent's turn carries what each call answered, for its step to open to", () => {
  const turns = mervTurns({
    commands: [
      {
        id: 'cmd_1',
        outcomes: [
          {
            callId: 'c1',
            name: 'task.write',
            input: { action: 'create' },
            output: { id: 'task_1' },
          },
          { callId: 'c2', name: 'screen.read', input: {}, output: { error: 'no screen' } },
        ],
      },
    ],
  } as never);
  assert.deepEqual(
    turns[0]!.steps.map(({ tool, action, failed, output }) => [tool, action, failed, output]),
    [
      ['task_write', 'create', undefined, '{\n  "id": "task_1"\n}'],
      ['screen_read', undefined, true, '{\n  "error": "no screen"\n}'],
    ],
  );
});

test("an agent session's steps become trail steps worded as merv-desktop words them", () => {
  const tool = (name: string, input: string, output: string, summary: string) => ({
    key: name,
    kind: 'tool' as const,
    label: name,
    summary,
    running: false,
    block: {
      kind: 'tool' as const,
      key: name,
      at: '2026-11-24T10:00:00Z',
      until: '2026-11-24T10:00:03Z',
      name,
      input,
      cut: 0,
      result: { output, error: false, cut: 0 },
    },
  });
  const read = trailStep(
    tool('Read', '{"file_path":"/repo/app.tsx"}', 'export {}', '/repo/app.tsx'),
    false,
  );
  assert.equal(said(read), 'Read app.tsx');
  assert.equal(read.detail, 'export {}');
  const ran = trailStep(tool('Bash', '{"command":"npm test"}', 'ok 1', 'npm test'), false);
  assert.equal(ran.kind, 'run');
  assert.match(said(ran), /test/i);
  assert.equal(ran.detail, 'ok 1');
  const own = trailStep(
    tool('mcp__merv__task.write', '{"action":"create"}', '{"id":"t"}', 'create'),
    false,
  );
  assert.equal(said(own), 'Created a task');
  assert.equal(own.ended! - own.at!, 3000);
});
