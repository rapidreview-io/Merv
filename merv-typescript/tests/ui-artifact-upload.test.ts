import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, settle, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
await import('../packages/ui/web/components.js');
const { UploadForm } = await import('../packages/ui/web/views/artifacts.js');

test('Files permits small uploads without Sandboxes and disables large uploads with a reason', async (t) => {
  t.after(unmount);
  await mount(createElement(UploadForm, { available: false, close() {} }));
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const button = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  assert.match(text(), /Files over 2 MB need project storage, which is unavailable/);
  Object.defineProperty(input, 'files', {
    value: [new File(['small'], 'small.txt')],
    configurable: true,
  });
  await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  await settle(5);
  assert.equal(button.disabled, false);
  Object.defineProperty(input, 'files', {
    value: [new File([new Uint8Array(2_000_001)], 'large.csv')],
    configurable: true,
  });
  await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  await settle(5);
  assert.equal(button.disabled, true);
});

test('Files enables large uploads when project storage is configured', async (t) => {
  t.after(unmount);
  await mount(createElement(UploadForm, { available: true, close() {} }));
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', {
    value: [new File([new Uint8Array(2_000_001)], 'large.csv')],
    configurable: true,
  });
  await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  await settle(5);
  assert.equal(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, false);
});

test('Files refuses a file over 512 MiB before hashing or calling Main', async (t) => {
  t.after(unmount);
  const fetches: unknown[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetches.push(input);
    return assert.fail('unused');
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  await mount(createElement(UploadForm, { available: true, close() {} }));
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(['huge'], 'huge.bin');
  Object.defineProperty(file, 'size', { value: 512 * 1024 * 1024 + 1 });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  await settle(5);
  await act(async () =>
    document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true })),
  );
  await settle(5);
  assert.match(text(), /Files up to 512 MiB can be uploaded/);
  assert.doesNotMatch(text(), /Hashing/);
  assert.deepEqual(fetches, []);
});
