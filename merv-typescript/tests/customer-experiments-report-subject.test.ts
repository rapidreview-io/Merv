import test from 'node:test';
import assert from 'node:assert/strict';
import { inquiryOf } from '../packages/customer-experiments/src/report-subject.js';

test('the inquiry comes from the plan, whatever its headings look like', () => {
  // Headings straight above their text, as plans are written now.
  const tight = `# Portuguese decision models
## Question
Which decision model is most accurate?
## Hypothesis and decision
Multilingual models beat English ones; the best two go to a larger evaluation.
## Data
- cases.jsonl`;
  assert.equal(
    inquiryOf(tight),
    'Multilingual models beat English ones; the best two go to a larger evaluation.',
  );
  // No such section: the first prose that is not the question.
  assert.equal(
    inquiryOf('# T\n\n## Question\nWhy?\n\n## Purpose of it all\nTo choose.'),
    'To choose.',
  );
  assert.equal(inquiryOf('Just a paragraph.\n\n## Method\nx'), 'Just a paragraph.');
  assert.equal(inquiryOf('# Only a title'), '');
});
