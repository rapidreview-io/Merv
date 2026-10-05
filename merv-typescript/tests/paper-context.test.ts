import { paperSnapshot } from '@merv/paper/context';
import type { PaperWorkspace } from '@merv/paper/types';
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Sections = { id: string; title?: string; content: string }[];
const revision = (number: number, sections: Sections) => ({
  revision: number,
  sections: sections.map((section) => ({ title: section.id, ...section })),
});
const paper = (
  documents: Record<string, { current: [number, Sections]; published?: [number, Sections] }>,
) =>
  Object.fromEntries(
    Object.entries(documents).map(([kind, { current, published }]) => [
      kind,
      {
        current: revision(...current),
        published: published
          ? { document: revision(...published), publication: { id: `paperpub_${kind}` } }
          : null,
      },
    ]),
  ) as unknown as PaperWorkspace['documents'];

test('the paper snapshot leads with the Problem, names its empty sections and marks long bodies for reading', () => {
  const snapshot = paperSnapshot(
    paper({
      literature: { current: [2, [{ id: 'prior', content: 'x'.repeat(10_000) }]] },
      problem: {
        current: [
          3,
          [
            { id: 'problem', content: 'p'.repeat(10_000) },
            { id: 'scope', content: 'Only Iris.' },
            { id: 'goals', content: 'Reproduce the paper method.' },
            { id: 'constraints', content: ' ' },
          ],
        ],
        published: [1, [{ id: 'old', content: 'y'.repeat(10_000) }]],
      },
    }),
    100,
  );
  assert.match(snapshot, /^Project paper snapshot/);
  assert.match(snapshot, /Empty Problem sections: constraints\./);
  assert.ok(snapshot.indexOf('problem current') < snapshot.indexOf('literature current'));
  assert.match(snapshot, /problem\/current revision 3; section goals/);
  assert.match(snapshot, /\nOnly Iris\.\n/);
  assert.match(snapshot, /\nReproduce the paper method\.\n/);
  assert.equal(snapshot.match(/\(10000 characters; read with paper\.read\)/g)?.length, 3);
  assert.match(snapshot, /publication paperpub_problem/);
});

test('the paper snapshot references an identical published body but keeps distinct drafts', () => {
  const methods = 'A detailed protocol. '.repeat(170);
  const current = 'Current measurements. '.repeat(80);
  const published = 'Published measurements. '.repeat(80);
  const snapshot = paperSnapshot(
    paper({
      methods: {
        current: [3, [{ id: 'protocol-new', title: 'Protocol', content: methods }]],
        published: [3, [{ id: 'protocol-published', title: 'Published', content: methods }]],
      },
      results: {
        current: [4, [{ id: 'outcome', content: current }]],
        published: [3, [{ id: 'outcome', content: published }]],
      },
    }),
  );
  assert.equal(snapshot.split(methods).length - 1, 1);
  assert.match(
    snapshot,
    /## methods published: Published\n.*\n\(same content as current section paper:methods:current:3:0:protocol-new\)/,
  );
  assert.ok(snapshot.includes(current) && snapshot.includes(published));
});

test('a published body is not referenced when its matching current body was shortened', () => {
  const body = 'x'.repeat(300);
  const snapshot = paperSnapshot(
    paper({
      methods: {
        current: [3, [{ id: 'protocol', content: body }]],
        published: [3, [{ id: 'protocol', content: body }]],
      },
    }),
    100,
  );
  assert.equal(snapshot.match(/300 characters; read with paper\.read/g)?.length, 2);
  assert.doesNotMatch(snapshot, /same content as current/);
});

test('a paper of many sections stays within the snapshot and counts what it leaves out', () => {
  const snapshot = paperSnapshot(
    paper({
      problem: { current: [7, [{ id: 'goals', content: 'A model' }]] },
      literature: {
        current: [
          3,
          Array.from({ length: 250 }, (_, index) => ({
            id: `section-${index}`,
            title: 'Long section title '.repeat(10),
            content: 'Evidence',
          })),
        ],
      },
    }),
  );
  assert.ok(snapshot.length <= 30_500, `${snapshot.length}`);
  assert.match(snapshot, /\nA model\n/);
  assert.match(snapshot, /\n\d+ more sections omitted; read with paper\.read\.$/);
});
