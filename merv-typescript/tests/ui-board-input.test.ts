import assert from 'node:assert/strict';
import test from 'node:test';
import './ui-render';
import { boardInput } from '../packages/ui/web/views/board-input';

class Pointer extends MouseEvent {
  pointerType: string;
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? 'pen';
    this.pointerId = init.pointerId ?? 1;
  }
}
Object.assign(globalThis, { PointerEvent: Pointer });
function setup(t: any) {
  const root = document.createElement('div');
  root.innerHTML =
    '<canvas class="interactive"></canvas><label><input data-testid="toolbar-freedraw"><span>Pen</span></label><input class="page-input">';
  document.body.append(root);
  const updates: any[] = [],
    heard: string[] = [];
  const off = boardInput(root, { updateScene: (next: any) => updates.push(next) } as any);
  const canvas = root.querySelector('canvas')!;
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
    root.addEventListener(type, (event) => heard.push(`${type}:${(event as any).pointerType}`));
  const send = (type: string, pointerType = 'pen', pointerId = 1, target: Element = canvas) =>
    target.dispatchEvent(
      new Pointer(type, {
        pointerType,
        pointerId,
        bubbles: true,
        cancelable: true,
        clientX: 25,
        clientY: 30,
      }),
    );
  t.after(() => {
    off();
    root.remove();
  });
  return { root, updates, heard, send, off };
}
test('a cancelled stroke releases the pen exactly once and accepts the next touch', (t) => {
  const f = setup(t);
  for (const ending of ['pointercancel', 'lostpointercapture', 'blur']) {
    f.heard.length = 0;
    f.send('pointerdown', 'touch', 2);
    f.send('pointerdown');
    assert.deepEqual(f.heard, ['pointerdown:touch', 'pointerup:touch', 'pointerdown:pen']);

    f.send('pointerup', 'touch', 2);
    assert.equal(f.heard.at(-1), 'pointerdown:pen');
    f.send('pointermove');
    if (ending === 'blur') window.dispatchEvent(new Event('blur'));
    else f.send(ending);
    f.send('lostpointercapture');
    assert.equal(f.heard.filter((event) => event === 'pointerup:pen').length, 1, ending);
    f.send('pointerdown', 'touch', 2);
    assert.equal(f.heard.at(-1), 'pointerdown:touch');
    f.send('pointerup', 'touch', 2);
  }
});
test('finger chooses drawing explicitly; unrelated page inputs keep normal touch behavior', (t) => {
  const f = setup(t);
  f.send('pointerdown', 'touch', 2, f.root.querySelector('span')!);
  assert.equal(f.updates[0].appState.penMode, false);
  f.send('pointerdown', 'touch', 3, f.root.querySelector('.page-input')!);
  assert.equal(f.updates.length, 1);
  f.off();
  f.send('pointerdown');
  f.send('pointerdown', 'touch', 4);
  assert.equal(f.heard.at(-1), 'pointerdown:touch');
});
