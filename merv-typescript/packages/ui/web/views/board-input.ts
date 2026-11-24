import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

/** Excalidraw treats a second touch as a pinch and may remove a short freedraw. A palm
 * must never reach that path while Pencil owns the canvas. Keep rejected fingers rejected
 * until they lift, including when the Pencil lifts first. Native canvas capture stays intact. */
export function boardInput(root: HTMLElement, api: ExcalidrawImperativeAPI) {
  let pen: number | undefined;
  const palms = new Set<number>();
  const touches = new Map<number, PointerEvent>();
  const active = new Set<number>();
  let lastPen: PointerEvent | undefined;
  let penCanvas: Element | undefined;
  const canvas = (event: Event) =>
    event.target instanceof Element &&
    root.contains(event.target) &&
    event.target.matches('canvas.interactive');
  const pointer = (event: PointerEvent) => {
    if (event.pointerType === 'touch' && (pen !== undefined || palms.has(event.pointerId))) {
      if (event.type === 'pointerdown') palms.add(event.pointerId);
      if (event.type === 'pointerup' || event.type === 'pointercancel')
        palms.delete(event.pointerId);
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.type === 'pointerdown' && canvas(event)) active.add(event.pointerId);
    if (['pointerup', 'pointercancel', 'lostpointercapture'].includes(event.type))
      active.delete(event.pointerId);
    if (event.pointerType === 'touch') {
      if (event.type === 'pointerdown' && canvas(event)) touches.set(event.pointerId, event);
      if (event.type === 'pointermove' && touches.has(event.pointerId))
        touches.set(event.pointerId, event);
      if (event.type === 'pointerup' || event.type === 'pointercancel')
        touches.delete(event.pointerId);
    }
    if (event.type === 'lostpointercapture' && event.pointerId === pen) {
      finish();
      return;
    }
    if (event.pointerType !== 'pen') return;
    if (event.type === 'pointerdown' && canvas(event)) {
      // A resting finger may arrive before Pencil. Release its canvas gesture first,
      // otherwise Excalidraw sees two pointers and refuses the pen entirely.
      for (const [id, touch] of touches) {
        (touch.target as Element).dispatchEvent(
          new PointerEvent('pointerup', {
            bubbles: true,
            pointerId: id,
            pointerType: 'touch',
            button: 0,
            buttons: 0,
            clientX: touch.clientX,
            clientY: touch.clientY,
          }),
        );
        palms.add(id);
      }
      touches.clear();
      pen = event.pointerId;
      penCanvas = event.target as Element;
    }
    if (event.pointerId === pen) {
      if (event.type === 'pointercancel' || event.type === 'lostpointercapture') finish();
      else lastPen = event;
    }
    if (
      event.pointerId === pen &&
      (event.type === 'pointerup' ||
        event.type === 'pointercancel' ||
        event.type === 'lostpointercapture')
    )
      pen = undefined;
  };
  const touch = (event: TouchEvent) => {
    if (pen === undefined && !palms.size) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  // Explicitly choosing the pen with a finger restores finger drawing after Pencil detection.
  // While Pencil is down this remains palm rejection, not a mode switch.
  const choose = (event: PointerEvent) => {
    if (
      event.pointerType === 'touch' &&
      pen === undefined &&
      event.target instanceof Element &&
      event.target.closest('label')?.querySelector('[data-testid="toolbar-freedraw"]')
    )
      api.updateScene({ appState: { penMode: false, penDetected: false } });
  };
  const finish = () => {
    const last = lastPen,
      target = penCanvas;
    if (pen === undefined || !last || !target) return;
    pen = undefined;
    active.delete(last.pointerId);
    // Excalidraw's per-stroke cleanup listens for pointerup on window. Safari can
    // cancel instead (app switch/capture loss); finish at the last actual ink point.
    target.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: last.pointerId,
        pointerType: 'pen',
        clientX: last.clientX,
        clientY: last.clientY,
        button: 0,
        buttons: 0,
      }),
    );
  };
  const reset = () => {
    finish();
    palms.clear();
    touches.clear();
    active.clear();
  };
  const events = [
    'pointerdown',
    'pointermove',
    'pointerup',
    'pointercancel',
    'lostpointercapture',
  ] as const;
  for (const name of events)
    window.addEventListener(name, pointer, { capture: true, passive: false });
  for (const name of ['touchstart', 'touchmove', 'touchend'] as const)
    window.addEventListener(name, touch, { capture: true, passive: false });
  root.addEventListener('pointerdown', choose, true);
  window.addEventListener('blur', reset);
  const dispose = () => {
    for (const name of events) window.removeEventListener(name, pointer, true);
    for (const name of ['touchstart', 'touchmove', 'touchend'] as const)
      window.removeEventListener(name, touch, true);
    root.removeEventListener('pointerdown', choose, true);
    window.removeEventListener('blur', reset);
  };
  dispose.active = () => active.size > 0;
  return dispose;
}
