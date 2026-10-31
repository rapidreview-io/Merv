// PDF.js for the offline page ArtifactPicture opens: a PDF is untrusted, so it is parsed here and
// not in the server. Only its text and a canvas's pixels leave. Its code runs on the page's own
// thread (no Worker), so whatever closes the page, time or memory, ends it too.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.min.mjs';
import * as worker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
import openjpeg from 'pdfjs-dist/wasm/openjpeg.wasm';
import jbig2 from 'pdfjs-dist/wasm/jbig2.wasm';

globalThis.pdfjsWorker = worker;
/** Scanned pages' decoders, which PDF.js would fetch. Nothing else is there to be fetched. */
const decoders = { 'openjpeg.wasm': openjpeg, 'jbig2.wasm': jbig2 };
class BinaryDataFactory {
  async fetch({ filename }) {
    if (!decoders[filename]) throw new Error(`${filename} is not bundled`);
    return decoders[filename].slice();
  }
}
/** One whole-page look is at most this many pixels on its longest side: its coordinates. */
const LONGEST = 1600;
/** An image inside a PDF past this many pixels is left out, not decoded. */
const MOST_IMAGE_PIXELS = 64_000_000;
/** The most empty pages a read walks past looking for text. */
const MOST_SCANNED = 200;
let doc, shown, unit;

window.pdfOpen = async (data) => {
  try {
    doc = await getDocument({
      data: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
      BinaryDataFactory,
      maxImageSize: MOST_IMAGE_PIXELS,
      enableXfa: false,
      verbosity: 0,
    }).promise;
    return { pageCount: doc.numPages };
  } catch (error) {
    return { failed: error?.name === 'PasswordException' ? 'encrypted' : 'malformed' };
  }
};
window.pdfSize = async (number) => {
  shown = await doc.getPage(number);
  const { width, height } = shown.getViewport({ scale: 1 });
  unit = LONGEST / Math.max(width, height);
  return { width: Math.round(width * unit), height: Math.round(height * unit) };
};
window.pdfDraw = async (canvas, area, scale) => {
  await shown.render({
    canvas,
    viewport: shown.getViewport({ scale: unit * scale }),
    transform: [1, 0, 0, 1, -area.x * scale, -area.y * scale],
  }).promise;
};
/** Up to `count` pages from `first`, past any empty ones until one has text, within `chars`. */
window.pdfText = async ({ first, count, chars }) => {
  const pages = [];
  const noText = [];
  let number = first;
  for (; number <= doc.numPages; number++) {
    const read = pages.length + noText.length;
    if (pages.length ? read >= count : noText.length >= MOST_SCANNED) break;
    const page = await doc.getPage(number);
    const { items } = await page.getTextContent();
    const text = items
      .map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : ''))
      .join('')
      .replaceAll('\0', '')
      .trim();
    page.cleanup();
    if (!text) {
      noText.push(number);
      continue;
    }
    // A page too long for one answer is cut, and said so; the next waits for the next answer.
    if (pages.length && text.length > chars) break;
    pages.push({
      page: number,
      text: text.slice(0, chars),
      ...(text.length > chars && { cut: true }),
    });
    chars -= Math.min(chars, text.length);
    if (!chars) {
      number++;
      break;
    }
  }
  return { pages, noText, ...(number <= doc.numPages && { next: number }) };
};
