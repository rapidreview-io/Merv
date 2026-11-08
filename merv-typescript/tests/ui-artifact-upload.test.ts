import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { deferred } from './fixtures/deferred.js';
import { click, mount, requests, serve, settle, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
await import('../packages/ui/web/components.js');
const { UploadControl } = await import('../packages/ui/web/views/artifacts.js');

const { setProject } = await import('../packages/ui/web/api.js');

for (const size of [32, 2_000_001])
  for (const leave of ['switch project', 'unmount'] as const)
    test(`Files stops a ${size}-byte upload after ${leave} during file preparation`, async (t) => {
      t.after(async () => {
        await unmount();
        setProject(null);
      });
      setProject('project-a');
      const ready = deferred();
      const resume = deferred();
      t.after(() => resume.resolve());
      const file = new File([new Uint8Array(size)], 'results.csv', { type: 'text/csv' });
      const bytes = await file.arrayBuffer();
      const arrayBuffer = async () => {
        ready.resolve();
        await resume.promise;
        return bytes;
      };
      if (size <= 2_000_000) Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer });
      else {
        const part = file.slice();
        Object.defineProperty(part, 'arrayBuffer', { value: arrayBuffer });
        Object.defineProperty(file, 'slice', { value: () => part });
      }
      await mount(createElement(UploadControl, { available: true }));
      const input = document.querySelector('input')!;
      Object.defineProperty(input, 'files', { value: [file] });
      await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
      await ready.promise;
      if (leave === 'switch project') await act(async () => setProject('project-b'));
      else await unmount();
      resume.resolve();
      await settle();
      assert.deepEqual(requests, [], 'no upload is admitted after its original page or scope left');
      assert.ok(!text().includes('Uploaded'), 'the abandoned upload is not reported as complete');
    });

/** Only the storage transport is simulated; the control hashes and sends the actual File. */
async function uploading(
  t: TestContext,
  replies: (number | 'network' | 'held')[],
  onPut?: () => void,
) {
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
    aborted = false;
    abort() {
      this.aborted = true;
    }
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
      onPut?.();
      const reply = replies.shift();
      assert.notEqual(reply, undefined, 'no unexpected storage request');
      if (reply === 'held') return;
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
  await mount(createElement(UploadControl, { available: true }));
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const settled = async () => {
    for (let attempt = 0; attempt < 250; attempt++) {
      await settle(10);
      if (!input.disabled) return;
    }
    assert.fail('Upload did not settle');
  };
  // The first press chooses the file and sends it; each later one is Retry.
  let chosen = false;
  const submit = async () => {
    if (!chosen) {
      chosen = true;
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
    } else await click('Retry');
    await settled();
  };
  const closed = () => (text().includes('Uploaded') ? 1 : 0);
  return { file, hash, headers, plan, puts, submit, closed };
}

test('Files does not complete an upload under a project selected during the storage PUT', async (t) => {
  setProject('project-a');
  const sent = deferred();
  const f = await uploading(t, [200], () => {
    setProject('project-b');
    sent.resolve();
  });
  t.after(() => setProject(null));
  serve('/tools/artifact.write:upload_begin', { body: { result: f.plan() } });
  serve('/tools/artifact.write:upload_complete', { body: { result: { id: 'art_file' } } });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [f.file] });
  await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  await sent.promise;
  await settle();
  assert.deepEqual(requests, ['POST /tools/artifact.write:upload_begin']);
  assert.equal(f.puts.length, 1);
  assert.equal(f.closed(), 0);
});

test('Files resumes a failed PUT with the same upload and fresh signed URL', async (t) => {
  const f = await uploading(t, ['network', 200]);
  let begins = 0;
  const resumed: unknown[] = [];
  let completed = 0;
  serve('/tools/artifact.write:upload_begin', () => {
    begins++;
    return { body: { result: f.plan() } };
  });
  serve('/tools/artifact.write:upload_resume', (_count, input) => {
    resumed.push(input);
    return { body: { result: f.plan('https://storage.example/fresh-signature') } };
  });
  serve('/tools/artifact.write:upload_complete', () => {
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

test('Files follows a conditional PUT refusal with server verification and retries a failed completion', async (t) => {
  const f = await uploading(t, [412]);
  let completions = 0;
  serve('/tools/artifact.write:upload_begin', { body: { result: f.plan() } });
  serve('/tools/artifact.write:upload_resume', (_count, input) => {
    assert.deepEqual(input, { uploadId: 'aup_file' });
    return { body: { result: { ...f.plan(), parts: [], completedParts: [1] } } };
  });
  serve('/tools/artifact.write:upload_complete', () =>
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
