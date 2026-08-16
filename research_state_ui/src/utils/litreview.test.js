import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authorLine, citedSections, paperSeed, sectionSeed, sourceLabel, sourceRef,
} from './litreview.js';

const ARXIV = {
  id: 'paper_abc123',
  norm_key: 'arxiv:2304.07193',
  url: 'https://arxiv.org/abs/2304.07193',
  title: 'DINOv2: Learning Robust Visual Features without Supervision',
  authors: ['Maxime Oquab', 'Timothée Darcet', 'Théo Moutakanni', 'Huy Vo'],
  year: '2023',
  description: 'We revisit existing approaches and combine techniques.',
  source_kind: 'arxiv',
  fetch_status: 'fetched',
  links: [
    { target_type: 'litreview_section', target_id: 'lit_open' },
    { target_type: 'experiment', target_id: 'exp_1' },
  ],
};

test('source reads as the citation key, not just the host', () => {
  assert.equal(sourceRef(ARXIV), 'arXiv:2304.07193');
  assert.equal(sourceLabel(ARXIV), 'arXiv');
  const doi = { norm_key: 'doi:10.1145/3290605', source_kind: 'doi', url: 'https://doi.org/10.1145/3290605' };
  assert.equal(sourceRef(doi), 'DOI 10.1145/3290605');
  const page = { source_kind: 'url', url: 'https://www.openreview.net/forum?id=x' };
  assert.equal(sourceRef(page), 'openreview.net');
  assert.equal(sourceLabel(page), 'openreview.net');
});

test('a row that predates norm_key still names its source', () => {
  assert.equal(sourceRef({ source_kind: 'arxiv', url: 'https://arxiv.org/abs/1' }), 'arXiv');
  assert.equal(sourceRef({ source_kind: 'url', url: 'not a url' }), '');
});

test('authors stop at a card-sized line', () => {
  assert.equal(authorLine(ARXIV.authors), 'Maxime Oquab · Timothée Darcet · Théo Moutakanni +1');
  assert.equal(authorLine(['Solo Author']), 'Solo Author');
  assert.equal(authorLine([]), '');
  assert.equal(authorLine(undefined), '');
});

test('cited sections resolve section links only, and only known ones', () => {
  const byId = new Map([['lit_open', { id: 'lit_open', title: 'Open baseline models' }]]);
  assert.deepEqual(citedSections(ARXIV, byId), ['Open baseline models']);
  assert.deepEqual(citedSections(ARXIV, new Map()), []);
  assert.deepEqual(citedSections({}, byId), []);
});

test('a paper seed carries the number as a badge and the facts the chip clips', () => {
  const seed = paperSeed({ paper: ARXIV, num: 7, sections: ['Open baseline models'] });
  assert.equal(seed.type, 'paper');
  assert.equal(seed.badge, '[7]');
  assert.equal(seed.label, ARXIV.title);
  assert.equal(seed.route, '/litreview#paper-paper_abc123');
  assert.equal(seed.navigable, true);
  assert.deepEqual(seed.detail, {
    type: 'paper',
    num: 7,
    title: ARXIV.title,
    description: ARXIV.description,
    authors: ARXIV.authors,
    year: '2023',
    source: 'arXiv:2304.07193',
    sections: ['Open baseline models'],
    flag: '',
  });
});

test('an unfetched paper falls back to its url and flags the gap', () => {
  const seed = paperSeed({ paper: { id: 'paper_x', url: 'https://x.test/p', fetch_status: 'manual', source_kind: 'url' } });
  assert.equal(seed.label, 'https://x.test/p');
  assert.equal(seed.badge, null);
  assert.equal(seed.detail.flag, 'manual');
  assert.equal(seed.detail.num, null);
});

test('a section seed counts its references', () => {
  const seed = sectionSeed({
    id: 'lit_open', title: 'Open baseline models', tldr: 'Seven families.',
    cited_papers: [{ id: 'paper_abc123' }, { id: 'paper_def' }],
  });
  assert.equal(seed.type, 'litreview_section');
  assert.equal(seed.route, '/litreview#lit-lit_open');
  assert.equal(seed.detail.refs, 2);
  assert.equal(sectionSeed({ id: 'lit_x' }).label, 'lit review section');
});
