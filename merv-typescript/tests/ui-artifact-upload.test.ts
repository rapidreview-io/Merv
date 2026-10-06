import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { mount, serve, settle, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
await import('../packages/ui/web/components.js');
const { UploadForm } = await import('../packages/ui/web/views/artifacts.js');

/** Only the storage transport is simulated; the form hashes and sends the actual File. */
async function uploading(t: TestContext, replies: (number | 'network')[]) {
  t.after(unmount);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'XMLHttpRequest', original);
    else Reflect.deleteProperty(globalThis, 'XMLHttpRequest');
  });
  const puts: StorageRequest[] = [];
  class StorageRequest {
    method = '';
    url = '';
    headers: Record<string, string> = {};
    body?: File;
    status = 0;
    upload: { onprogress?: (event: { loaded: number }) => void } = {};
    onload?: () => void;
    onerror?: () => void;
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send(file: File) {
      this.body = file;
      puts.push(this);
      const reply = replies.shift();
      assert.notEqual(reply, undefined, 'no unexpected storage request');
      queueMicrotask(() => {
        this.upload.onprogress?.({ loaded: file.size });
        if (reply === 'network') this.onerror?.();
        else {
          this.status = reply!;
          this.onload?.();
        }
      });
    }
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    value: StorageRequest,
  });
  const bytes = new Uint8Array(2_000_001).fill(71);
  const file = new File([bytes], 'results.csv', { type: 'text/csv' });
  const hash = createHash('sha256').update(bytes).digest('hex');
  const headers = {
    'x-amz-checksum-sha256': Buffer.from(hash, 'hex').toString('base64'),
    'if-none-match': '*',
  };
  const plan = (url = 'https://storage.example/signed-file') => ({
    uploadId: 'aup_file',
    partSize: file.size,
    partCount: 1,
    parts: [{ partNumber: 1, url, size: file.size, headers }],
    completedParts: [],
    nextPart: null,
  });
  let closed = 0;
  await mount(createElement(UploadForm, { available: true, close: () => closed++ }));
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  const submit = async () => {
    await act(async () =>
      document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true })),
    );
    for (let attempt = 0; attempt < 250; attempt++) {
      await settle(10);
      if (!document.querySelector('fieldset')!.disabled) return;
    }
    assert.fail('Upload did not settle');
  };
  return { file, hash, headers, plan, puts, submit, closed: () => closed };
}

test('Files sends one whole file with its signed checksum headers before completing', async (t) => {
  const f = await uploading(t, [200]);
  const calls: [string, Record<string, unknown>][] = [];
  serve('/tools/artifact.upload_begin', (_count, input) => {
    calls.push(['begin', input]);
    return { body: { result: f.plan() } };
  });
  serve('/tools/artifact.upload_complete', (_count, input) => {
    calls.push(['complete', input]);
    assert.equal(f.puts.length, 1);
    return { body: { result: { id: 'art_file' } } };
  });
  await f.submit();
  assert.deepEqual(
    calls.map(([name]) => name),
    ['begin', 'complete'],
  );
  assert.deepEqual(calls[0][1], {
    title: f.file.name,
    size: f.file.size,
    sha256: f.hash,
    mediaType: 'text/csv',
    requestId: calls[0][1].requestId,
  });
  assert.equal(typeof calls[0][1].requestId, 'string');
  assert.deepEqual(calls[1][1], { uploadId: 'aup_file' });
  assert.equal(f.puts[0].body, f.file, 'the selected File is sent whole, without slicing');
  assert.equal(f.puts[0].method, 'PUT');
  assert.equal(f.puts[0].url, f.plan().parts[0].url);
  assert.deepEqual(f.puts[0].headers, f.headers);
  assert.equal(f.closed(), 1);
});

test('Files resumes a failed PUT with the same upload and fresh signed URL', async (t) => {
  const f = await uploading(t, ['network', 200]);
  let begins = 0;
  const resumed: unknown[] = [];
  let completed = 0;
  serve('/tools/artifact.upload_begin', () => {
    begins++;
    return { body: { result: f.plan() } };
  });
  serve('/tools/artifact.upload_resume', (_count, input) => {
    resumed.push(input);
    return { body: { result: f.plan('https://storage.example/fresh-signature') } };
  });
  serve('/tools/artifact.upload_complete', () => {
    completed++;
    return { body: { result: { id: 'art_file' } } };
  });
  await f.submit();
  assert.match(text(), /Object storage is unreachable/);
  assert.equal(completed, 0);
  assert.equal(f.closed(), 0);
  await f.submit();
  assert.equal(begins, 1);
  assert.deepEqual(resumed, [{ uploadId: 'aup_file' }]);
  assert.deepEqual(
    f.puts.map((put) => put.url),
    [f.plan().parts[0].url, 'https://storage.example/fresh-signature'],
  );
  assert.ok(f.puts.every((put) => put.body === f.file));
  assert.equal(completed, 1);
  assert.equal(f.closed(), 1);
});

test('Files completes an already stored file without a PUT', async (t) => {
  const f = await uploading(t, []);
  serve('/tools/artifact.upload_begin', {
    body: { result: { ...f.plan(), parts: [], completedParts: [1] } },
  });
  serve('/tools/artifact.upload_complete', { body: { result: { id: 'art_file' } } });
  await f.submit();
  assert.deepEqual(f.puts, []);
  assert.equal(f.closed(), 1);
});

test('Files follows a conditional PUT refusal with server verification and retries a failed completion', async (t) => {
  const f = await uploading(t, [412]);
  let completions = 0;
  serve('/tools/artifact.upload_begin', { body: { result: f.plan() } });
  serve('/tools/artifact.upload_resume', (_count, input) => {
    assert.deepEqual(input, { uploadId: 'aup_file' });
    return { body: { result: { ...f.plan(), parts: [], completedParts: [1] } } };
  });
  serve('/tools/artifact.upload_complete', () =>
    ++completions === 1
      ? { status: 409, body: { error: { code: 'upload_pending', message: 'Not yet verified' } } }
      : { body: { result: { id: 'art_file' } } },
  );
  await f.submit();
  assert.equal(completions, 1, '412 reaches the authoritative completion check');
  assert.match(text(), /Not yet verified/);
  assert.equal(f.closed(), 0, '412 alone cannot mark the upload successful');
  await f.submit();
  assert.equal(completions, 2);
  assert.equal(f.puts.length, 1, 'the stored object is not uploaded again');
  assert.equal(f.closed(), 1);
});

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

test('Files keeps the rows it shows while older files load', async (t) => {
  t.after(unmount);
  const { setToken } = await import('../packages/ui/web/api.js');
  setToken('fixture-token');
  t.after(() => setToken(null));
  const { MemoryRouter, Routes, Route } = await import('react-router-dom');
  const { SessionProvider } = await import('../packages/ui/web/session.js');
  const { ArtifactsView } = await import('../packages/ui/web/views/artifacts.js');
  const project = { id: 'project_1', name: 'Grokking', createdAt: '2026-09-01T00:00:00Z' };
  const actor = { id: 'actor_1', projectId: project.id, name: 'Ada', role: 'reader' };
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', {
    body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] },
  });
  serve('/tools/ui.shell', { body: { result: { actor, project, rows: [], plugins: [] } } });
  serve('/tools/artifact.storage_status', { body: { result: { available: false } } });
  const files = Array.from({ length: 400 }, (_, at) => ({
    id: `art_${String(at).padStart(32, '0')}`,
    projectId: project.id,
    createdBy: actor.id,
    hash: 'abc',
    size: 10,
    createdAt: new Date().toISOString(),
    title: `File ${at}`,
    mediaType: 'text/plain',
  }));
  serve('/tools/artifact.list', (_, sent) => ({
    body: { result: files.slice(0, Number(sent.limit)) },
  }));
  // The older page is still on its way when the page is next drawn.
  const answered = globalThis.fetch;
  t.after(() => void (globalThis.fetch = answered));
  globalThis.fetch = ((input: string, init: { body?: string }) =>
    typeof init?.body === 'string' && JSON.parse(init.body).limit === 400
      ? new Promise(() => {})
      : answered(input, init)) as typeof fetch;
  const row = { id: 'artifacts', label: 'Files', path: '/artifacts', view: { kind: 'artifacts' } };
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/artifacts'] },
      createElement(
        SessionProvider,
        null,
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/artifacts/*',
            element: createElement(ArtifactsView as never, { row, shell: { rows: [row] } }),
          }),
        ),
      ),
    ),
  );
  await settle(10);
  assert.ok(text().includes('File 199'), text().slice(0, 300));
  const older = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === 'Show older files',
  );
  assert.ok(older, 'a full first page offers the next');
  await act(async () => older!.click());
  await settle(10);
  assert.ok(text().includes('File 0') && text().includes('File 199'), 'the rows it had stay put');
});
