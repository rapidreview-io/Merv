/**
 * A replay's words on the page: the band that shows them, the clock that picks them (a pause keeps
 * them, a scrub or a step finds them, the end holds the last), the pace a browser remembers, and
 * the room the layout leaves them.
 */
import './ui-render.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';

// The clock runs without Excalidraw: it only tells one what to show.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(name,ctx,next){if(name==='@excalidraw/excalidraw'&&/\\/views\\/board-(projection|player)\\./.test(ctx.parentURL??''))return{url:'data:text/javascript,'+encodeURIComponent('export const CaptureUpdateAction={NEVER:0};export const restoreElements=x=>x;export const exportToCanvas=()=>{};export const getCommonBounds=()=>[0,0,0,0];export const getDataURL=()=>"";export const reconcileElements=x=>x;'),shortCircuit:true};return next(name,ctx)}`,
    ),
  import.meta.url,
);
// Asked for less motion, ink lands at once: the clock and the words are what is left to test.
const media = window.matchMedia;
const calm = ((query: string) => ({
  ...media(query),
  matches: /reduced-motion/.test(query),
})) as typeof window.matchMedia;
Object.assign(window, { matchMedia: calm });
Object.assign(globalThis, {
  matchMedia: calm,
  devicePixelRatio: 1,
  innerWidth: 1440,
  innerHeight: 900,
});
// A canvas that takes every stroke and draws none.
const blank = new Proxy({}, { get: () => () => undefined });
(
  window as unknown as { HTMLCanvasElement: typeof HTMLCanvasElement }
).HTMLCanvasElement.prototype.getContext = (() => blank) as never;

const { BoardFilm } = await import('../packages/ui/web/views/board-film.js');
const { Projection } = await import('../packages/ui/web/views/board-projection.js');
const { linesAt, timelineOf } = await import('../packages/ui/web/views/board-timeline.js');
type Change = Parameters<typeof timelineOf>[0][number];

const fixture = (name: string): Change[] => {
  const read = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
  return Array.isArray(read) ? read : read.changes;
};
const board = fixture('replay-history.json');

/** An Excalidraw that only remembers what it was told. */
const canvasApi = (width = 1440) => {
  let state: Record<string, unknown> = {
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
    width,
    height: 900,
    offsetLeft: 0,
    offsetTop: 0,
    viewBackgroundColor: '#ffffff',
    openDialog: null,
  };
  return {
    getAppState: () => state,
    getSceneElements: () => [],
    getFiles: () => ({}),
    addFiles: () => undefined,
    updateScene: (scene: { appState?: object }) => {
      state = { ...state, ...scene.appState };
    },
  } as never;
};
function projected(changes: Change[], quick = false) {
  const seen = { ended: 0, at: -1 };
  const line = timelineOf(changes, quick);
  const projection = new Projection(
    canvasApi(),
    canvasApi(),
    document.createElement('canvas'),
    line,
    new BoardFilm(line, (raw) => raw as never),
    [],
    {
      place: (at) => (seen.at = at),
      changed: () => undefined,
      ended: () => seen.ended++,
      nameOf: () => 'Merv',
      say: () => undefined,
      view: () => undefined,
      more: async () => null,
      below: () => 0,
      refused: () => undefined,
    },
  );
  const words = () => linesAt(projection.line, seen.at);
  return { projection, seen, words };
}

test('stepping goes line by line, through words said with no drawing too', (t) => {
  const { projection, words } = projected(board);
  t.after(() => projection.stop());
  projection.seek(0);
  const heard: string[] = [];
  for (let i = 0; i < 4; i++) {
    projection.step(1);
    heard.push(words().now?.words.slice(0, 16) ?? '');
  }
  assert.deepEqual(heard, [
    'Conversation 0: ',
    'First we collect',
    'Then we compare ',
    'Then we compare ',
  ]);
  projection.step(-2);
  assert.match(words().now!.words, /^First we collect/);
  assert.equal(projection.line.rate, 1);
  projection.seek(projection.line.units[4]!.start + 1);
  const standing = projection.film.at;
  projection.retime(timelineOf(board, true));
  assert.ok(projection.line.quick);
  assert.equal(projection.film.at, standing);
  assert.equal(
    Math.round(projection.at),
    Math.round(projection.line.units[4]!.start + 1 / projection.line.rate),
  );
});
