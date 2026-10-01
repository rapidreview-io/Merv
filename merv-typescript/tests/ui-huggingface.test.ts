import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, serve, settle, text, unmount } from './ui-render.js';
sessionStorage.setItem('merv:token', 'fixture-token');
const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
const { HuggingFaceSettings } = await import('../packages/ui/web/views/huggingface.js');
const { setToken } = await import('../packages/ui/web/api.js');
const status = { available: true, configured: false, updatedAt: null };
const write = async (value: string) => {
  const field = document.querySelector<HTMLInputElement>('input')!;
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!;
  await act(async () => {
    set.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
};
const submit = async () =>
  act(async () => {
    document
      .querySelector('form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });

test('Hugging Face form masks input, sends only token, clears it and removes stored access', async (t) => {
  t.after(unmount);
  const marker = 'hf_NONCREDENTIAL_BROWSER_MARKER';
  serve('/secrets/huggingface', (n, body) => {
    if (n === 1 || n === 3) return { body: status };
    assert.deepEqual(body, { token: marker });
    return { body: { ...status, configured: true, updatedAt: '2026-10-01T12:00:00Z' } };
  });
  await mount(createElement(HuggingFaceSettings));
  await settle();
  const field = document.querySelector<HTMLInputElement>('input')!;
  assert.equal(field.type, 'password');
  assert.equal(field.autocomplete, 'off');
  await write(marker);
  await submit();
  await settle();
  assert.equal(field.value, '');
  assert.ok(text().includes('Token saved.'));
  assert.ok(!text().includes(marker));
  for (const storage of [localStorage, sessionStorage])
    for (let i = 0; i < storage.length; i++)
      assert.ok(!storage.getItem(storage.key(i)!)!.includes(marker));
  await click('Remove token');
  await settle();
  assert.ok(text().includes('No token saved.'));
});

test('failure clears input and does not echo server errors; unavailable storage disables saving', async (t) => {
  t.after(unmount);
  serve('/secrets/huggingface', (n) =>
    n === 1
      ? { body: status }
      : {
          status: 503,
          body: { error: { code: 'unavailable', message: 'hf_NONCREDENTIAL_ECHO' } },
        },
  );
  await mount(createElement(HuggingFaceSettings));
  await settle();
  await write('hf_NONCREDENTIAL_ECHO');
  await submit();
  await settle();
  assert.equal(document.querySelector<HTMLInputElement>('input')!.value, '');
  assert.ok(!text().includes('hf_NONCREDENTIAL_ECHO'));
  assert.ok(text().includes('could not be saved'));
  await unmount();
  serve('/secrets/huggingface', { body: { ...status, available: false } });
  await mount(createElement(HuggingFaceSettings));
  await settle();
  assert.equal(document.querySelector<HTMLInputElement>('input')!.disabled, true);
  assert.equal(document.querySelector<HTMLButtonElement>('button')!.disabled, true);
});

test('changing account clears an unsaved token', async (t) => {
  t.after(unmount);
  serve('/secrets/huggingface', { body: status });
  await mount(createElement(HuggingFaceSettings));
  await settle();
  await write('hf_NONCREDENTIAL_UNSAVED');
  await act(async () => setToken('another-account'));
  await settle();
  assert.equal(document.querySelector<HTMLInputElement>('input')!.value, '');
});
