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

test('paper context references an identical published body but keeps revisions and distinct drafts', () => {
  const methods = 'A detailed protocol. '.repeat(170);
  const currentResults = 'Current measurements. '.repeat(80);
  const publishedResults = 'Published measurements. '.repeat(80);
  const documents = {
    methods: {
      current: {
        revision: 3,
        sections: [
          { id: 'protocol-new', title: 'Protocol', content: methods },
          { id: 'brief', content: 'Short' },
        ],
      },
      published: {
        document: {
          revision: 3,
          sections: [
            { id: 'protocol-published', title: 'Published protocol', content: methods },
            { id: 'brief', content: 'Short' },
          ],
        },
        publication: { reviewId: 'review-3' },
      },
    },
    results: {
      current: { revision: 4, sections: [{ id: 'outcome', content: currentResults }] },
      published: {
        document: { revision: 3, sections: [{ id: 'outcome', content: publishedResults }] },
      },
    },
  };
  const result = boundedPaperContext(documents, 12_000);
  assert.equal(result.methods.current.sections[0]!.content, methods);
  assert.match(
    result.methods.published.document.sections[0]!.content,
    /same content as current revision 3, section protocol-new; read with paper\.read/,
  );
  assert.equal(JSON.stringify(result).split(methods).length - 1, 1);
  assert.equal(result.methods.published.document.revision, 3);
  assert.equal(result.methods.published.publication.reviewId, 'review-3');
  assert.equal(result.methods.published.document.sections[0]!.title, 'Published protocol');
  assert.equal(result.methods.published.document.sections[1]!.content, 'Short');
  assert.equal(result.results.current.sections[0]!.content, currentResults);
  assert.equal(result.results.published.document.sections[0]!.content, publishedResults);
  assert.equal(documents.methods.published.document.sections[0]!.content, methods);
});

test('a published section is not called inline when its matching current body was shortened', () => {
  const body = 'x'.repeat(300);
  const documents = {
    methods: {
      current: { revision: 3, sections: [{ id: 'protocol', content: body }] },
      published: { document: { revision: 3, sections: [{ id: 'protocol', content: body }] } },
    },
  };
  const result = boundedPaperContext(documents, 100);
  assert.match(
    result.methods.current.sections[0]!.content,
    /300 characters; read with paper\.read/,
  );
  assert.match(
    result.methods.published.document.sections[0]!.content,
    /300 characters; read with paper\.read/,
  );
  assert.doesNotMatch(JSON.stringify(result), /same content as current/);
});
