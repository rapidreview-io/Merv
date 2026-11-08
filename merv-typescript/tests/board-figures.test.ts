import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Caller } from '@merv/contracts';
import { httpApp } from './fixtures/app.js';

/** A PDF of these page contents, written out by hand: Helvetica text and painted rectangles. */
function pdf(pages: string[], encrypted = false) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...pages.flatMap((content, i) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents ${5 + 2 * i} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ]),
  ];
  if (encrypted)
    objects.push(
      `<< /Filter /Standard /V 1 /R 2 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> /P -4 >>`,
    );
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const at = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<00><00>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
const words = (text: string) => `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
/** A blue rectangle on the page's left half, its top half: x 0-300, y 0-400 as a look's pixels at 800 high. */
const BLUE = '0 0 1 rg 0 400 300 400 re f';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

async function fixture(t: test.TestContext) {
  const f = await httpApp(t, 'board-figures-');
  const credentials = f.app.ctx.scope.credentials;
  const caller = (boot: Awaited<ReturnType<typeof credentials.bootstrap>>): Caller => ({
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  });
  const owner = caller(await credentials.bootstrap({ projectName: 'Mine', actorName: 'Owner' }));
  const stranger = caller(await credentials.bootstrap({ projectName: 'Other', actorName: 'S' }));
  const tools = f.app.ctx.tools;
  const file = (title: string, bytes: Buffer, mediaType = 'application/pdf', who = owner) =>
    f.app.ctx.artifacts.create(who, {
      title,
      content: bytes.toString('base64'),
      encoding: 'base64',
      mediaType,
    });
  const draw = (who: Caller, input: object) =>
    tools.call('board.write:draw', who, input) as Promise<{
      board: { id: string };
      created: Record<string, string>;
    }>;
  const look = (who: Caller, input: object) =>
    tools.call('artifact.read:look', who, input) as Promise<{
      image: { data: string; mimeType: string };
      viewport: { x: number; y: number; width: number; height: number };
      source: { width: number; height: number };
      pdfPage?: number;
      pageCount?: number;
    }>;
  const text = (who: Caller, input: object) =>
    tools.call('artifact.read:text', who, input) as Promise<{
      pageCount: number;
      pages: { page: number; text: string; cut?: true }[];
      noText: number[];
      next?: number;
    }>;
  return { ...f, owner, stranger, tools, file, draw, look, text, board: f.app.ctx.board };
}

test('a PDF reads by page: numbered, paged, and naming the pages with no text', async (t) => {
  const f = await fixture(t);
  const paper = await f.file(
    'paper.pdf',
    pdf([words('First page'), BLUE, words('Third page'), words('Fourth page')]),
  );
  const start = await f.text(f.owner, { artifactId: paper.id, pages: 3 });
  assert.equal(start.pageCount, 4);
  assert.deepEqual(start.pages, [
    { page: 1, text: 'First page' },
    { page: 3, text: 'Third page' },
  ]);
  assert.deepEqual(start.noText, [2]);
  assert.equal(start.next, 4);
  const rest = await f.text(f.owner, { artifactId: paper.id, page: start.next });
  assert.deepEqual(rest.pages, [{ page: 4, text: 'Fourth page' }]);
  assert.equal(rest.next, undefined);
  // Past an empty page to the next with text, not an answer holding nothing.
  const onward = await f.text(f.owner, { artifactId: paper.id, page: 2, pages: 1 });
  assert.deepEqual(onward.pages, [{ page: 3, text: 'Third page' }]);
  assert.deepEqual(onward.noText, [2]);
  await assert.rejects(f.text(f.owner, { artifactId: paper.id, page: 5 }), { code: 'pdf_page' });
  // Bounded by what the tool takes.
  await assert.rejects(f.text(f.owner, { artifactId: paper.id, pages: 21 }));
  // The same read from a PDF that is all ASCII and one labelled only by its name.
  const named = await f.file('labelled.PDF', pdf([words('Named')]), 'application/octet-stream');
  assert.equal((await f.text(f.owner, { artifactId: named.id })).pages[0]!.text, 'Named');
  const note = await f.file('note.md', Buffer.from('words'), 'text/markdown');
  await assert.rejects(f.text(f.owner, { artifactId: note.id }), { code: 'artifact_not_pdf' });
});

test('another project’s file is not read, seen or placed', async (t) => {
  const f = await fixture(t);
  const paper = await f.file('paper.pdf', pdf([words('Private')]));
  const image = await f.file('red.png', PNG, 'image/png');
  const theirs = await f.board.create(f.stranger, 'Theirs');
  await assert.rejects(f.text(f.stranger, { artifactId: paper.id }), { code: 'not_found' });
  await assert.rejects(f.look(f.stranger, { artifactId: paper.id }), { code: 'not_found' });
  for (const artifactId of [paper.id, image.id])
    await assert.rejects(
      f.draw(f.stranger, { board: theirs.id, ops: [{ op: 'image', artifactId }] }),
      { code: 'not_found' },
    );
  assert.equal((await f.board.scene(f.stranger, theirs.id)).elements.length, 0);
  // What one project placed stays its own, and its bytes with it.
  const drawn = await f.draw(f.owner, {
    title: 'Mine',
    ops: [{ op: 'image', key: 'i', artifactId: image.id }],
  });
  const { fileId } = (await f.board.scene(f.owner, drawn.board.id)).elements[0] as unknown as {
    fileId: string;
  };
  await assert.rejects(f.board.image(f.stranger, fileId), { code: 'not_found' });
});
