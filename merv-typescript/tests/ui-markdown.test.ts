import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, rawView, serve, settle, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
const { MemoryRouter } = await import('react-router-dom');
const { Markdown, safeHref } = await import('../packages/ui/web/markdown.js');
const { parseInline } = await import('../packages/ui/web/markdown-parse.js');
const { ArtifactBody } = await import('../packages/ui/web/views/artifacts.js');
const ART = 'art_bb6477ae526d45c99b2d066a4ae959e2';
const page = (source: string, names?: unknown) =>
  createElement(MemoryRouter, null, createElement(Markdown, { source, names }));

test('only http, https, mailto and relative addresses ever become an href', () => {
  for (const bad of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' java\tscript:alert(1)',
    'java\nscript:alert(1)',
    '\u0001javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://example.org/x',
    '',
  ])
    assert.equal(safeHref(bad), null, bad);
  // A file in the project's code: an exact ref and a path inside the repository, nothing else.
  const commit = 'a'.repeat(40);
  for (const good of [
    `code-file:${commit}:experiments/x/metrics.json`,
    'code-file:main:README.md',
    `code-file:wf_${'b'.repeat(32)}:src/a.py`,
  ])
    assert.deepEqual(safeHref(good), { href: good, external: false }, good);
  for (const bad of [
    `code-file:${commit}:/etc/passwd`,
    `code-file:${commit}:a/../../b`,
    'code-file:HEAD~1:a.py',
    `code-file:${commit}:`,
    'code-file:main:a//b',
  ])
    assert.equal(safeHref(bad), null, bad);
  assert.deepEqual(safeHref('https://example.org/a'), {
    href: 'https://example.org/a',
    external: true,
  });
  assert.deepEqual(safeHref('mailto:lab@example.org'), {
    href: 'mailto:lab@example.org',
    external: true,
  });
  assert.deepEqual(safeHref('notes/run.md#seed'), { href: 'notes/run.md#seed', external: false });
  // Two slashes, or a slash and a backslash, leave this origin: they are external, never relative.
  assert.deepEqual(safeHref('/\\evil.example/x'), {
    href: 'https://evil.example/x',
    external: true,
  });

  // A refused address leaves its words behind as plain text.
  assert.deepEqual(parseInline('[click](javascript:alert(1)) <javascript:alert(1)>'), [
    { type: 'text', value: 'click <javascript:alert(1)>' },
  ]);
});

test('an HTML file is drawn as its page in a sandbox, and its source is behind raw view', async (t) => {
  t.after(async () => await unmount());
  const artifact = {
    id: ART,
    projectId: 'project_1',
    createdBy: 'actor_1',
    title: 'report.html',
    mediaType: 'text/html',
    hash: '52d0a404b837827d',
    size: 64,
    createdAt: new Date().toISOString(),
  };
  const html = '<h1>Report</h1><script>document.title = "ran"</script>';
  serve('/tools/artifact.read', {
    body: { result: { artifact, encoding: 'utf8', content: html } },
  });
  await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(ArtifactBody, { artifactId: ART, metadata: artifact }),
    ),
  );
  await settle(10);
  const frame = document.querySelector('.file-html iframe');
  assert.equal(frame?.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame?.getAttribute('srcdoc'), html);
  // Never Merv's own document: the page is only ever inside the frame.
  assert.equal(document.querySelector('h1')?.textContent ?? null, null);
  assert.equal(await rawView(true), 'off');
  assert.equal(await rawView(), 'on');
  assert.equal(document.querySelector('.file-html'), null);
  assert.match(document.querySelector('.code-block pre')?.textContent ?? '', /^<h1>Report<\/h1>/);
});

test('changing project removes the previous project’s figure before the new read completes', async (t) => {
  const { setProject, projectSelection } = await import('../packages/ui/web/api.js');
  const previous = projectSelection();
  t.after(async () => {
    await unmount();
    setProject(previous);
  });
  setProject('figure-project-a');
  const id = `art_${'f'.repeat(32)}`;
  const artifact = { id, mediaType: 'image/png', size: 3, title: 'Private figure' };
  serve('/tools/artifact.get', { body: { result: artifact } });
  serve('/tools/artifact.read:content', {
    body: { result: { artifact, encoding: 'base64', content: 'AAAA' } },
  });
  await mount(page(`![Private figure](${id})`));
  await settle(30);
  assert.ok(document.querySelector('.md-figure img'));
  serve('/tools/artifact.get', {
    status: 403,
    body: { error: { code: 'forbidden', message: 'Unavailable' } },
  });
  await act(async () => setProject('figure-project-b'));
  assert.equal(document.querySelector('.md-figure img'), null);
  await settle(30);
  assert.match(text(), /Figure unavailable/);
});
