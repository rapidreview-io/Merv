import { boundedPaperContext } from '@merv/contracts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('paper context protects current goals and marks oversized sections for reading', () => {
  const documents = {
    literature: {
      current: { revision: 2, sections: [{ id: 'prior', content: 'x'.repeat(10_000) }] },
      published: null,
    },
    problem: {
      current: {
        revision: 3,
        sections: [
          { id: 'problem', content: 'p'.repeat(10_000) },
          { id: 'scope', content: 'Only Iris.' },
          { id: 'goals', content: 'Reproduce the paper method.' },
        ],
      },
      published: {
        document: { revision: 1, sections: [{ id: 'old', content: 'y'.repeat(10_000) }] },
      },
    },
  };
  const result = boundedPaperContext(documents, 100);
  assert.equal(result.problem.current.revision, 3);
  assert.equal(result.problem.current.sections[2]!.content, 'Reproduce the paper method.');
  assert.equal(result.problem.current.sections[1]!.content, 'Only Iris.');
  assert.match(result.problem.current.sections[0]!.content, /read with paper.read/);
  assert.match(result.literature.current.sections[0]!.content, /read with paper.read/);
  assert.match(result.problem.published!.document.sections[0]!.content, /read with paper.read/);
  assert.equal(documents.problem.current.sections[0]!.content.length, 10_000);
});
