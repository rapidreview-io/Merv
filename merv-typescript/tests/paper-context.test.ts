import { boundedPaperContext, paperJsonCap } from '@merv/contracts';
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

/** The count a capped paper adds to a revision whose sections it dropped. */
const omittedSections = (revision: object) =>
  (revision as { omittedSections?: number }).omittedSections;

/** A mature paper: many sections whose titles and IDs outweigh their short bodies. */
function maturePaper(count: number) {
  const sections = (kind: string, n: number) =>
    Array.from({ length: n }, (_, index) => ({
      id: `${kind}-${index}`,
      title: `${kind} ${index} `.padEnd(300, 't'),
      content: `Finding ${index} of the ${kind} section.`,
    }));
  return {
    problem: {
      current: {
        revision: 7,
        sections: [
          { id: 'goals', title: 'Goals', content: 'Reproduce the method on Iris.' },
          { id: 'scope', title: 'Scope', content: 'Only Iris.' },
          { id: 'problem', title: 'Problem', content: 'The baseline is not reproducible.' },
          { id: 'constraints', title: 'Constraints', content: 'One GPU.' },
          ...sections('problem', count / 4 - 4),
        ],
      },
      published: {
        document: { revision: 6, sections: sections('problem', count / 4) },
        publication: { reviewId: 'review-6' },
      },
    },
    literature: {
      current: { revision: 3, sections: sections('literature', count / 4) },
      published: null,
    },
    methods: {
      current: { revision: 2, sections: sections('methods', count / 4) },
      published: null,
    },
  };
}

test('under its JSON cap the paper context is exactly what the room alone gives', () => {
  for (const documents of [maturePaper(40), maturePaper(400)]) {
    const uncapped = boundedPaperContext(documents, 16_000);
    const length = JSON.stringify(uncapped).length;
    assert.deepEqual(boundedPaperContext(documents, 16_000, length), uncapped);
    assert.deepEqual(boundedPaperContext(documents, 16_000, Infinity), uncapped);
  }
});

test('a paper over its JSON cap marks, then drops, every section but the current problem keys', () => {
  const documents = maturePaper(400);
  assert.ok(JSON.stringify(boundedPaperContext(documents, 16_000)).length > 100_000);
  // Each frozen recipe's cap: task.work@1/2, the 96k recipes, task.review@4, experiments.
  for (const maxChars of [48_000, 96_000, 128_000, 160_000]) {
    const cap = paperJsonCap(maxChars);
    const result = boundedPaperContext(documents, 16_000, cap);
    assert.ok(JSON.stringify(result).length <= cap, `${maxChars}`);
    assert.deepEqual(
      result.problem.current.sections,
      documents.problem.current.sections.slice(0, 4),
    );
    assert.equal(result.problem.current.revision, 7);
    assert.equal(omittedSections(result.problem.current), 96);
    assert.deepEqual(result.problem.published.document, {
      revision: 6,
      sections: [],
      omittedSections: 100,
    });
    assert.equal(result.problem.published.publication.reviewId, 'review-6');
    assert.equal(omittedSections(result.literature.current), 100);
  }
  assert.equal(documents.literature.current.sections.length, 100);
});

test('marking long bodies is tried before dropping sections', () => {
  const body = (label: string) => `${label} `.repeat(500);
  const documents = {
    problem: {
      current: {
        revision: 2,
        sections: [
          { id: 'goals', title: 'Goals', content: body('goal') },
          { id: 'background', title: 'Background', content: body('background') },
          { id: 'tiny', title: 'Tiny', content: 'ok' },
        ],
      },
      published: null,
    },
    methods: {
      current: {
        revision: 1,
        sections: [{ id: 'protocol', title: 'Protocol', content: body('step') }],
      },
      published: null,
    },
  };
  const uncapped = JSON.stringify(boundedPaperContext(documents, 40_000)).length;
  const result = boundedPaperContext(documents, 40_000, uncapped - 1000);
  assert.equal(result.problem.current.sections[0]!.content, body('goal'));
  assert.equal(
    result.problem.current.sections[1]!.content,
    `(${body('background').length} characters; read with paper.read)`,
  );
  // A marker longer than its body would only grow the JSON.
  assert.equal(result.problem.current.sections[2]!.content, 'ok');
  assert.match(result.methods.current.sections[0]!.content, /characters; read with paper\.read/);
  assert.equal(omittedSections(result.problem.current), undefined);
});
