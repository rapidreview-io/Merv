import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { chromium, type Page } from 'playwright-core';
import type { BoardElement } from '@merv/board';
import type { Caller } from '@merv/contracts';
import { conversationRules } from '../packages/pi/src/conversation-rules.js';
import { ArtifactPicture } from '../packages/artifacts/src/picture.js';
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

/** A solid PNG of this colour. */
function png(width: number, height: number, [r, g, b]: [number, number, number]) {
  const chunk = (type: string, data: Buffer) => {
    const named = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(named));
    return Buffer.concat([size, named, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(width * 3).map((_, i) => [r, g, b][i % 3]!),
  ]);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The colour at a fraction of a picture's size, as a person would see it. */
async function colorAt(data: string, x = 0.5, y = 0.5) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate(
      async ({ data, x, y }) => {
        const im = new Image();
        im.src = `data:image/jpeg;base64,${data}`;
        await im.decode();
        const c = document.createElement('canvas');
        c.width = im.naturalWidth;
        c.height = im.naturalHeight;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(im, 0, 0);
        return [...ctx.getImageData(c.width * x, c.height * y, 1, 1).data.slice(0, 3)];
      },
      { data, x, y },
    );
  } finally {
    await browser.close();
  }
}
const isBlue = ([r, g, b]: number[]) => b! > 200 && r! < 60 && g! < 60;
const isRed = ([r, g, b]: number[]) => r! > 200 && g! < 60 && b! < 60;

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
  // Pi's own caller, as the Pi plugin would vouch for it: a conversation under its person.
  tools.registerCallerRules('conversation', conversationRules);
  const source = await f.app.ctx.scope.delegationSource(owner);
  f.app.ctx.scope.registerConversationAuthority({ require: async () => source });
  const pi: Caller = {
    actorId: owner.actorId,
    projectId: owner.projectId,
    conversation: { id: 'pi', epoch: 1, commandId: 'turn', runtimeId: 'runtime' },
  };
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
  return { ...f, owner, stranger, pi, tools, file, draw, look, text, board: f.app.ctx.board };
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

test('a long page is cut and said so; what follows waits for the next read', async (t) => {
  const f = await fixture(t);
  const line = 'x'.repeat(100);
  const long = Array.from({ length: 700 }, (_, i) => `BT /F1 6 Tf 0 ${i} Td (${line}) Tj ET`);
  const paper = await f.file('long.pdf', pdf([long.join('\n'), words('After')]));
  const first = await f.text(f.owner, { artifactId: paper.id });
  assert.equal(first.pages[0]!.text.length, 64_000);
  assert.equal(first.pages[0]!.cut, true);
  assert.equal(first.next, 2);
});

test('a scanned, encrypted or malformed PDF is refused saying which', async (t) => {
  const f = await fixture(t);
  const scanned = await f.file('scan.pdf', pdf([BLUE, BLUE]));
  await assert.rejects(f.text(f.owner, { artifactId: scanned.id }), (error: any) => {
    assert.equal(error.code, 'pdf_no_text');
    assert.match(error.message, /Pages 1–2 of 2 have no text.*scanned or image-only/);
    assert.deepEqual(error.details.noText, [1, 2]);
    return true;
  });
  // It can still be seen.
  assert.ok(
    isBlue(await colorAt((await f.look(f.owner, { artifactId: scanned.id })).image.data, 0.2, 0.2)),
  );
  const locked = await f.file('locked.pdf', pdf([words('Secret')], true));
  await assert.rejects(f.text(f.owner, { artifactId: locked.id }), { code: 'pdf_encrypted' });
  await assert.rejects(f.look(f.owner, { artifactId: locked.id }), { code: 'pdf_encrypted' });
  for (const bytes of [Buffer.from('%PDF-1.7\nno such thing'), Buffer.from('not a pdf')]) {
    const broken = await f.file('broken.pdf', bytes);
    await assert.rejects(f.text(f.owner, { artifactId: broken.id }), { code: 'pdf_malformed' });
    await assert.rejects(f.look(f.owner, { artifactId: broken.id }), { code: 'pdf_malformed' });
  }
});

test('a page past its time or its memory is ended from outside', async (t) => {
  // What a file could do to the page, without the file: it never answers, or it never stops.
  const stuck = (picture: ArtifactPicture, script: () => unknown) =>
    (picture as unknown as { inTurn(work: (page: Page) => unknown): Promise<unknown> }).inTurn(
      (page) => page.evaluate(script),
    );
  const quick = new ArtifactPicture(undefined, 500);
  const small = new ArtifactPicture(undefined, 60_000, 1);
  t.after(async () => await Promise.all([quick.close(), small.close()]));
  await assert.rejects(
    stuck(quick, () => {
      for (;;);
    }),
    { code: 'artifact_picture_timeout' },
  );
  await assert.rejects(
    stuck(small, () => new Promise(() => {})),
    {
      code: 'artifact_picture_memory',
    },
  );
});

test('a PDF page is seen as an image, a region of it in more detail', async (t) => {
  const f = await fixture(t);
  const paper = await f.file('paper.pdf', pdf([words('One'), BLUE]));
  const whole = await f.look(f.owner, { artifactId: paper.id, page: 2 });
  assert.equal(whole.image.mimeType, 'image/jpeg');
  assert.deepEqual([whole.pdfPage, whole.pageCount], [2, 2]);
  assert.deepEqual(whole.source, { width: 1200, height: 1600 });
  assert.deepEqual(whole.viewport, { x: 0, y: 0, width: 1200, height: 1600 });
  assert.ok(isBlue(await colorAt(whole.image.data, 0.25, 0.25)));
  assert.ok(
    !isBlue(
      await colorAt((await f.look(f.owner, { artifactId: paper.id })).image.data, 0.25, 0.25),
    ),
  );
  // The page's own pixels name a region; it is drawn afresh, up to four times over.
  const view = { action: 'region', x: 400, y: 600, width: 400, height: 400 };
  const close = await f.look(f.owner, { artifactId: paper.id, page: 2, view });
  assert.deepEqual(close.viewport, { x: 400, y: 600, width: 400, height: 400 });
  const inPixels = async (data: string) =>
    (await colorAt(data, 0.1, 0.1)).concat(await colorAt(data, 0.9, 0.9));
  const seen = await inPixels(close.image.data);
  assert.ok(isBlue(seen.slice(0, 3)) && !isBlue(seen.slice(3)), 'the edge at x 600, y 800');
  // What reaches past the page is cut to it, and what misses it is refused.
  const over = { action: 'region', x: 1000, y: 1400, width: 900, height: 900 };
  assert.deepEqual((await f.look(f.owner, { artifactId: paper.id, view: over })).viewport, {
    x: 1000,
    y: 1400,
    width: 200,
    height: 200,
  });
  const off = { action: 'region', x: 5000, y: 0, width: 10, height: 10 };
  await assert.rejects(f.look(f.owner, { artifactId: paper.id, view: off }), {
    code: 'artifact_picture_view',
  });
  // Zoom and pan start from the whole picture, a look having no camera to keep.
  const zoomed = await f.look(f.owner, {
    artifactId: paper.id,
    page: 2,
    view: { action: 'zoom', factor: 4, center: [300, 400] },
  });
  assert.deepEqual(zoomed.viewport, { x: 150, y: 200, width: 300, height: 400 });
  await assert.rejects(f.look(f.owner, { artifactId: paper.id, page: 3 }), { code: 'pdf_page' });
});

test('an image goes on a board from an image artifact, and is a shape like a pasted one', async (t) => {
  const f = await fixture(t);
  const red = await f.file('red.png', png(40, 20, [255, 0, 0]), 'image/png');
  const drawn = await f.draw(f.owner, {
    title: 'Figures',
    ops: [
      { op: 'note', key: 'n', text: 'Beside it', at: [0, 0] },
      { op: 'image', key: 'i', artifactId: red.id, alt: 'A red block', near: 'n', side: 'right' },
      { op: 'arrow', from: 'n', to: 'i' },
    ],
  });
  const { elements } = await f.board.scene(f.owner, drawn.board.id);
  const image = elements.find((el) => el.type === 'image') as BoardElement & {
    fileId: string;
    customData: Record<string, unknown>;
  };
  assert.deepEqual([image.width, image.height], [40, 20]);
  assert.equal(image.id, drawn.created.i);
  assert.equal(image.customData.by, undefined, 'a person’s key is not Pi');
  const arrow = elements.find((el) => el.type === 'arrow') as unknown as {
    endBinding: { elementId: string };
  };
  assert.equal(arrow.endBinding.elementId, image.id);
  const bytes = await f.board.image(f.owner, image.fileId);
  assert.equal(bytes.mediaType, 'image/jpeg');
  // get says what it is, where it came from and where it stands.
  const read = (await f.tools.call('board.read:get', f.owner, { board: drawn.board.id })) as {
    shapes: { id: string; kind: string; alt?: string; source?: object; at: number[] }[];
  };
  const said = read.shapes.find((shape) => shape.id === image.id)!;
  assert.equal(said.kind, 'image');
  assert.equal(said.alt, 'A red block');
  assert.deepEqual(said.source, { artifactId: red.id });
  // It is drawn in a look, moves like any shape, and history replays it.
  const look = (await f.tools.call('board.read:look', f.owner, {
    board: drawn.board.id,
    focus: image.id,
  })) as { image: { data: string } };
  assert.ok(isRed(await colorAt(look.image.data)));
  await f.draw(f.owner, {
    board: drawn.board.id,
    ops: [{ op: 'move', id: image.id, at: [900, 50] }],
  });
  const moved = (await f.board.scene(f.owner, drawn.board.id)).elements.find(
    (el) => el.id === image.id,
  )!;
  assert.deepEqual([moved.x, moved.y], [900, 50]);
  const history = await f.board.history(f.owner, drawn.board.id);
  const steps = history.changes.map((step) => step.shapes.find((el) => el.id === image.id));
  assert.deepEqual([steps[0]!.x, steps[1]!.x], [image.x, 900]);
  // Bytes outlive the shape, as a pasted image's do for history.
  await f.draw(f.owner, { board: drawn.board.id, ops: [{ op: 'delete', ids: [image.id] }] });
  assert.equal((await f.board.image(f.owner, image.fileId)).mediaType, 'image/jpeg');
  // The same picture again is kept once and may be drawn at a size asked for.
  const again = await f.draw(f.owner, {
    board: drawn.board.id,
    ops: [{ op: 'image', key: 'j', artifactId: red.id, width: 400 }],
  });
  const second = (await f.board.scene(f.owner, drawn.board.id)).elements.find(
    (el) => el.id === again.created.j,
  )!;
  assert.equal(second.fileId, image.fileId);
  assert.deepEqual([second.width, second.height], [400, 200]);
});

test('a crop of a PDF page goes on a board and shows in its look', async (t) => {
  const f = await fixture(t);
  const paper = await f.file('paper.pdf', pdf([words('Text'), BLUE]));
  const region = { x: 100, y: 100, width: 400, height: 200 };
  const drawn = await f.draw(f.pi, {
    title: 'Crop',
    ops: [{ op: 'image', key: 'fig', artifactId: paper.id, page: 2, region, alt: 'Figure 1' }],
  });
  const image = (await f.board.scene(f.owner, drawn.board.id)).elements[0] as BoardElement & {
    fileId: string;
    customData: Record<string, unknown>;
  };
  // Four times its 400 × 200 on the page, cut to a look's 1600 and shown no wider than 640.
  assert.deepEqual([image.width, image.height], [640, 320]);
  assert.deepEqual(image.customData, {
    by: 'agent',
    alt: 'Figure 1',
    source: { artifactId: paper.id, page: 2, region },
  });
  const held = await f.board.image(f.owner, image.fileId);
  assert.ok(isBlue(await colorAt(held.content.toString('base64'))));
  const look = (await f.tools.call('board.read:look', f.owner, {
    board: drawn.board.id,
    focus: image.id,
  })) as { image: { data: string } };
  assert.ok(isBlue(await colorAt(look.image.data)));
});

test('what cannot be placed is refused and draws nothing', async (t) => {
  const f = await fixture(t);
  const made = await f.board.create(f.owner, 'Refusals');
  const on = (op: object, who = f.owner) => f.draw(who, { board: made.id, ops: [op] });
  const image = await f.file('red.png', png(4, 4, [255, 0, 0]), 'image/png');
  const refused = async (code: string, op: object) => {
    await assert.rejects(on(op), { code }, code);
    assert.equal((await f.board.scene(f.owner, made.id)).elements.length, 0);
  };
  const note = await f.file('note.md', Buffer.from('words'), 'text/markdown');
  const svg = await f.file('x.svg', Buffer.from('<svg/>'), 'image/svg+xml');
  const gif = await f.file('x.gif', Buffer.from('GIF89a'), 'image/gif');
  for (const { id } of [note, svg, gif])
    await refused('image_type', { op: 'image', artifactId: id });
  await refused('not_found', { op: 'image', artifactId: 'art_missing' });
  // Only an artifact is a source: a board's picture is not one by another name.
  await refused('invalid_input', { op: 'image', artifactId: made.id });
  await refused('invalid_input', { op: 'image', artifactId: image.id, width: 5 });
  await assert.rejects(
    f.draw(f.owner, {
      board: made.id,
      ops: Array.from({ length: 9 }, () => ({ op: 'image', artifactId: image.id })),
    }),
    { code: 'board_too_many_images' },
  );
  // Atomic with its call: a bad neighbour leaves the board as it was.
  await refused('board_shape_not_found', { op: 'image', artifactId: image.id, near: 'nothing' });
  // Whatever the source draws must fit Board's own limit and pass its content check.
  const real = f.tools.picture;
  const big = Buffer.concat([png(1, 1, [0, 0, 0]), Buffer.alloc(10 * 1024 * 1024)]);
  const answers = {
    big: big.toString('base64'),
    nonsense: Buffer.from('<svg/>').toString('base64'),
  };
  for (const [data, code] of [
    [answers.big, 'image_too_large'],
    [answers.nonsense, 'image_type'],
  ] as const) {
    f.tools.picture = (async () => ({
      image: { data, mimeType: 'image/jpeg' },
      html: '',
      width: 1,
      height: 1,
      path: '',
    })) as never;
    await refused(code, { op: 'image', artifactId: image.id });
  }
  f.tools.picture = real;
  // A file over the limit of a read is refused before its bytes are fetched.
  const store = f.app.ctx.artifacts;
  const get = store.get;
  store.get = (async () => ({ ...image, size: 17 * 1024 * 1024 })) as never;
  await refused('artifact_picture_size', { op: 'image', artifactId: image.id });
  store.get = get;
});

test('another project’s file is not read, seen or placed', async (t) => {
  const f = await fixture(t);
  const paper = await f.file('paper.pdf', pdf([words('Private')]));
  const image = await f.file('red.png', png(4, 4, [255, 0, 0]), 'image/png');
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

test('Pi is offered both abilities and may use them', async (t) => {
  const f = await fixture(t);
  const listed = await f.tools.describe(f.pi);
  const schema = (name: string) =>
    JSON.stringify(listed.find((tool) => tool.name === name)?.inputSchema);
  assert.match(schema('artifact.read'), /"text"/);
  assert.match(schema('board.write'), /"image"/);
  const paper = await f.file('paper.pdf', pdf([words('For Pi')]));
  assert.equal((await f.text(f.pi, { artifactId: paper.id })).pages[0]!.text, 'For Pi');
});
