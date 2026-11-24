import assert from 'node:assert/strict';
import test from 'node:test';
import { penSizePlace } from '../packages/ui/web/views/board-pen-size';

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});
const view = { width: 1440, height: 900 };
const size = { width: 100, height: 36 };
const whole = box(0, 0, 1440, 900);
const centre = (place: { left: number }, frame = whole) => frame.left + place.left + size.width / 2;

test('the pen sizes sit just under a top toolbar, centred on the pencil', () => {
  const pencil = box(150, 20, 44, 44);
  const place = penSizePlace(pencil, box(70, 12, 450, 60), whole, view, size);
  assert.equal(centre(place), 172);
  assert.equal(place.top, 80);
});

test('on a phone the toolbar is at the foot, so the sizes ride just above it', () => {
  const phone = { width: 390, height: 844 };
  const pencil = box(122, 790, 42, 42);
  const place = penSizePlace(pencil, box(10, 780, 370, 54), box(0, 0, 390, 844), phone, size);
  assert.equal(centre(place), 143);
  assert.equal(place.top, 780 - 8 - 36);
});

test('they step past a control already beside the toolbar instead of covering it', () => {
  const pencil = box(122, 790, 42, 42);
  const chip = box(170, 752, 50, 20);
  const place = penSizePlace(
    pencil,
    box(10, 780, 370, 54),
    box(0, 0, 390, 844),
    { width: 390, height: 844 },
    size,
    [chip, box(10, 780, 370, 54)],
  );
  assert.equal(centre(place), 143);
  assert.equal(place.top + size.height, chip.top - 8);
});

test('they stay inside the visible board, measured from the box they are placed in', () => {
  const frame = box(12, 60, 500, 400);
  const pencil = box(14, 66, 40, 40);
  const place = penSizePlace(pencil, box(14, 62, 300, 48), frame, view, size);
  assert.equal(frame.left + place.left, 20);
  assert.equal(frame.top + place.top, 118);
  const far = penSizePlace(box(1420, 20, 40, 40), box(1000, 12, 470, 56), whole, view, size);
  assert.equal(far.left + size.width, 1440 - 8);
});
