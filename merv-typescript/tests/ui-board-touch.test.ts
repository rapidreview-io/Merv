import assert from 'node:assert/strict';
import test from 'node:test';
/** A finger on the board: a tap opens a card with the palm in hand, and a tap wakes a resting web page and keeps it awake. */
const { mount, settle, unmount } = await import('./ui-render.js');
const React = await import('react');
const { act, createElement } = React;
const { cardAt, isTap, tapOpens, TAP_SLOP } =
  await import('../packages/ui/web/views/board-tap-open.js');
const { usePageActivity, pageActivity } =
  await import('../packages/ui/web/views/board-page-activity.js');

const view = { scrollX: 0, scrollY: 0, zoom: { value: 1 }, offsetLeft: 0, offsetTop: 0 };
const page = { id: 'page', x: 10, y: 20, width: 200, height: 100, link: 'merv:page' };
const box = { id: 'box', x: 0, y: 0, width: 400, height: 400 };
const activityApi = (overlap = false) =>
  ({
    getSceneElements: () =>
      [0, 1].map((i) => ({
        id: String(i),
        x: 100 + (overlap ? 0 : i * 300),
        y: 100,
        width: 200,
        height: 200,
      })),
    getAppState: () => view,
  }) as never;

/** A pointer event as a finger (or the mouse) makes it: jsdom has no PointerEvent of its own. */
function pointer(
  type: string,
  x: number,
  y: number,
  kind = 'touch',
  at = 0,
  target: EventTarget = document,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperties(event, {
    pointerType: { value: kind },
    pointerId: { value: 1 },
    timeStamp: { value: at },
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

test('with the palm in hand, a tap on a card selects it with the cursor, and the palm comes back when it closes', (t) => {
  const surface = document.createElement('div');
  const canvas = document.createElement('canvas');
  surface.append(canvas);
  document.body.append(surface);
  let state = {
    activeTool: { type: 'hand' },
    selectedElementIds: {} as Record<string, true>,
    ...view,
  };
  const tools: string[] = [];
  let changed: (elements: unknown, state: unknown) => void = () => undefined;
  const api = {
    getAppState: () => state,
    getSceneElements: () => [box, page],
    setActiveTool: ({ type }: { type: string }) => {
      tools.push(type);
      state = { ...state, activeTool: { type } };
      changed([], state);
    },
    updateScene: ({ appState }: { appState: Partial<typeof state> }) => {
      state = { ...state, ...appState };
      changed([], state);
    },
    onChange: (fn: typeof changed) => {
      changed = fn;
      return () => {
        changed = () => undefined;
      };
    },
  };
  const stop = tapOpens(api as never, surface);
  t.after(() => {
    stop();
    surface.remove();
  });

  pointer('pointerdown', 50, 50, 'touch', 0, canvas);
  pointer('pointerup', 80, 50, 'touch', 100, canvas);
  assert.deepEqual(tools, [], "a drag stays the palm's");
  pointer('pointerdown', 50, 50, 'mouse', 0, canvas);
  pointer('pointerup', 50, 50, 'mouse', 50, canvas);
  assert.deepEqual(tools, [], 'the mouse has its cursor already');
  pointer('pointerdown', 300, 300, 'touch', 0, canvas);
  pointer('pointerup', 300, 300, 'touch', 50, canvas);
  assert.deepEqual(tools, [], 'a tap on a plain shape or on nothing does nothing');

  pointer('pointerdown', 50, 50, 'touch', 0, canvas);
  pointer('pointerup', 51, 50, 'touch', 120, canvas);
  assert.deepEqual(tools, ['selection'], 'a tap on a card takes the cursor');
  assert.deepEqual(
    state.selectedElementIds,
    { page: true },
    'and selects the card, which opens its reader',
  );
  api.updateScene({ appState: { selectedElementIds: {} } });
  assert.deepEqual(tools, ['selection', 'hand'], 'closed, the palm is back');
});
