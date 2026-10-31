import assert from 'node:assert/strict';
import test from 'node:test';
import type { Caller } from '@merv/contracts';
import { httpApp } from './fixtures/app.js';
import {
  caretAfter,
  deepLink,
  handoffInline,
  handoffPrompt,
  hunkOf,
  rebased,
} from '../packages/ui/web/views/board-outcome-text.js';

async function fixture(t: test.TestContext) {
  const f = await httpApp(t, 'board-outcome-');
  const boot = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Sketches',
    actorName: 'Owner',
  });
  const stranger = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Other',
    actorName: 'Stranger',
  });
  const caller = (made: typeof boot): Caller => ({
    projectId: made.project.id,
    actorId: made.actor.id,
    credentialId: made.credential.id,
  });
  const owner = caller(boot);
  const board = f.app.ctx.board;
  const made = await board.create(owner, 'Sketch');
  const tool = (name: string, who: Caller, input: unknown) =>
    f.app.ctx.tools.call(name, who, input) as Promise<never>;
  return { board, owner, stranger: caller(stranger), id: made.id, tool, f: f.app.ctx };
}
const coded = (code: string) => (error: { code?: string }) => error.code === code;

test('an outcome is written by edits at any revision, and whole only at its own', async (t) => {
  const { board, owner, id } = await fixture(t);
  await assert.rejects(board.writeOutcome(owner, { board: id }), coded('invalid_board_input'));
  const made = await board.writeOutcome(owner, {
    board: id,
    title: 'Plan',
    content: 'one two two',
  });
  assert.equal(made.revision, 1);
  const outcome = { board: id, outcome: made.id };
  await assert.rejects(
    board.writeOutcome(owner, { ...outcome, edits: [{ find: 'two', replace: 'x' }] }),
    coded('board_outcome_conflict'),
    'a find occurring twice is refused',
  );
  await assert.rejects(
    board.writeOutcome(owner, { ...outcome, edits: [{ find: 'nine', replace: 'x' }] }),
    coded('board_outcome_conflict'),
  );
  const edited = await board.writeOutcome(owner, {
    ...outcome,
    edits: [{ find: 'one', replace: 'zero' }],
  });
  assert.equal(edited.revision, 2);
  await assert.rejects(
    board.writeOutcome(owner, { ...outcome, content: 'stale', expectedRevision: 1 }),
    coded('board_outcome_conflict'),
    'whole text at a stale revision is refused',
  );
  await assert.rejects(
    board.writeOutcome(owner, { ...outcome, content: 'none' }),
    coded('board_outcome_conflict'),
  );
  await assert.rejects(
    board.writeOutcome(owner, {
      ...outcome,
      content: 'both',
      expectedRevision: 2,
      edits: [{ find: 'one', replace: 'x' }],
    }),
    coded('invalid_board_input'),
  );
  const whole = await board.writeOutcome(owner, {
    ...outcome,
    content: 'new',
    expectedRevision: 2,
  });
  assert.equal(whole.revision, 3);
  assert.equal((await board.outcome(owner, id, made.id)).text, 'new');
  // Nothing changed is no revision.
  const same = await board.writeOutcome(owner, {
    ...outcome,
    title: 'Plan',
    edits: [{ find: 'new', replace: 'new' }],
  });
  assert.equal(same.revision, 3);
  const [line] = (await board.scene(owner, id, Number.MAX_SAFE_INTEGER)).outcomes;
  assert.deepEqual([line!.id, line!.title, line!.revision], [made.id, 'Plan', 3]);
  assert.equal('text' in line!, false, 'the poll carries no text');
});

test('a send leaves the revision, and the same send is one entry', async (t) => {
  const { board, owner, id } = await fixture(t);
  const made = await board.writeOutcome(owner, { board: id, title: 'Plan', content: 'text' });
  const sent = { board: id, outcome: made.id, artifactId: 'art_one', revision: 1 };
  await board.outcomeSent(owner, { ...sent, how: 'copy' });
  await board.outcomeSent(owner, { ...sent, how: 'copy' });
  const line = await board.outcomeSent(owner, { ...sent, how: 'claude' });
  assert.equal(line.revision, 1);
  assert.deepEqual(
    line.sent.map((one) => one.how),
    ['copy', 'claude'],
  );
});

test('an outcome stays in its project', async (t) => {
  const { board, owner, stranger, id, f } = await fixture(t);
  const made = await board.writeOutcome(owner, { board: id, title: 'Plan', content: 'text' });
  const reader = await f.scope.credentials.issueActor(owner, { name: 'R', role: 'reader' });
  await assert.rejects(
    board.outcomeSent(
      { ...owner, actorId: reader.actor.id, credentialId: reader.credential.id },
      { board: id, outcome: made.id, how: 'copy', artifactId: 'art_forged', revision: 1 },
    ),
    coded('forbidden'),
    'a reader notes no send',
  );
  await assert.rejects(board.outcome(stranger, id, made.id), coded('not_found'));
  await assert.rejects(
    board.writeOutcome(stranger, {
      board: id,
      outcome: made.id,
      content: 'x',
      expectedRevision: 1,
    }),
    coded('not_found'),
  );
});

test('freezing an unchanged outcome twice gives the same file through the tools', async (t) => {
  const { board, owner, id, tool } = await fixture(t);
  const { outcome } = (await tool('board.write:outcome', owner, {
    board: id,
    title: 'Plan',
    content: '# Plan',
  })) as { outcome: { id: string; revision: number } };
  const file = () =>
    tool('artifact.write:create', owner, {
      title: 'Plan',
      content: '# Plan',
      mediaType: 'text/markdown',
      requestId: `${outcome.id}:${outcome.revision}`,
    }) as Promise<{ id: string }>;
  assert.equal((await file()).id, (await file()).id);
  const read = (await tool('board.read:get', owner, { board: id })) as {
    outcomes: { id: string }[];
  };
  assert.deepEqual(
    read.outcomes.map((one) => one.id),
    [outcome.id],
  );
});

const apply = (text: string, hunk: { find: string; replace: string }) => {
  const at = text.indexOf(hunk.find);
  assert.ok(at >= 0 && at === text.lastIndexOf(hunk.find), `${hunk.find} occurs once`);
  return text.slice(0, at) + hunk.replace + text.slice(at + hunk.find.length);
};

test('what was typed becomes one hunk whose find occurs once', () => {
  for (const [saved, draft] of [
    ['one two three', 'one 2 three'],
    ['a\na\na\n', 'a\na!\na\n'],
    ['same\nsame\nsame', 'same\nsame\nsame\n'],
    ['same same', 'same  same'],
    ['\n\n\n', '\n\nx\n'],
    ['x', ''],
    ['😀 a', '😁 a'],
    ['# T\n\nline\n\nline\n', '# T\n\nline\n\nmore\nline\n'],
  ] as const) {
    const hunk = hunkOf(saved, draft)!;
    assert.equal(apply(saved, hunk), draft, JSON.stringify([saved, draft]));
  }
  assert.equal(hunkOf('', 'first'), null, 'an empty text has nothing to find');
});

test('typing survives what the agent writes, elsewhere or over it', () => {
  const base = 'Intro\n\nThe rate is 10.\n\nEnd';
  const mine = 'Intro\n\nThe rate is 12.\n\nEnd';
  const below = `${base}\n\nNext paragraph.`;
  assert.equal(rebased(base, mine, below), `${mine}\n\nNext paragraph.`);
  // On the very line the agent quoted to add after it.
  assert.equal(rebased('Goal: 10', 'Goal: 12', 'Goal: 10\n\nThen more.'), 'Goal: 12\n\nThen more.');
  // Two edits by the agent around the typing keep both.
  assert.equal(rebased(base, mine, `Lead\n\n${base}\n\nTail`), `Lead\n\n${mine}\n\nTail`);
  // A stray digit is not what was changed: the whole line is, and it no longer stands.
  assert.deepEqual(hunkOf('Rate: 10', 'Rate: 12'), { find: 'Rate: 10', replace: 'Rate: 12' });
  assert.equal(
    rebased('Rate: 10', 'Rate: 12', 'Rate: 11\nCount: 0'),
    'Rate: 12\n\nRate: 11\nCount: 0',
  );
  // The agent rewrote the sentence being typed in and wrote around it: all of it stands.
  assert.equal(
    rebased('A\n\nRate 10\n\nZ', 'A\n\nRate 12\n\nZ', 'Intro\n\nA\n\nRate 11\n\nZ\n\nEnd'),
    'Intro\n\nA\n\nRate 12\n\nRate 11\n\nZ\n\nEnd',
  );
  assert.equal(rebased(base, base, below), below, 'nothing typed takes what came');
  assert.equal(rebased(base, mine, base), mine, 'nothing came keeps what was typed');
  assert.equal(rebased('', 'mine', 'theirs'), 'theirs\n\nmine', 'nobody is lost in an empty text');
});

test('the caret stays with the words it stood in', () => {
  const was = 'first line\nsecond';
  assert.equal(caretAfter(was, `${was}\nthird`, 5), 5, 'text after it leaves it');
  assert.equal(caretAfter(was, `top\n${was}`, 5), 9, 'text before it moves it');
  assert.equal(caretAfter(was, 'first LINE\nsecond', 7), 10, 'within what changed, to its end');
  assert.equal(caretAfter('abc', 'XabcY', 2), 3, 'changes on both sides leave it among its words');
});

test('the handoff prompt names everything, and fits a deep link', () => {
  const ids = { projectId: `prj_${'p'.repeat(40)}`, boardId: `board_${'b'.repeat(40)}` };
  const handoff = {
    ...ids,
    title: `Plan"\u0007\n${'é'.repeat(198)}`,
    origin: 'https://example.test',
  };
  const artifact = `art_${'a'.repeat(40)}`;
  const prompt = handoffPrompt(handoff, artifact);
  for (const part of [
    ids.projectId,
    ids.boardId,
    artifact,
    'artifact.read content',
    'board.read get',
    'board.read look',
    'https://example.test/ui/settings/keys',
  ])
    assert.ok(prompt.includes(part), part);
  assert.equal(/[\u0000-\u0009\u000b-\u001f]/.test(prompt), false);
  assert.equal(prompt.split('\n').length, 6, 'a title stays on its line');
  assert.ok(prompt.includes(`("Plan'  é`), 'and in its quotes');
  assert.ok(prompt.length <= 5000, 'Claude Code takes q up to 5,000 characters');
  const link = deepLink(prompt);
  const url = new URL(link);
  assert.equal(url.protocol + url.hostname, 'claude-cli:open');
  assert.equal(url.searchParams.get('q'), prompt);
  const inline = handoffInline(handoff, 'The whole plan.');
  assert.ok(inline.endsWith('The whole plan.') && !inline.includes('art_'));
});
