import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { customerPage } from '../packages/customer-experiments/src/customer-page.js';

const requestId = 'ce_page_fixture';
const base = '/customer-experiments/requests/' + requestId;
const plan = {
  title: 'Does the new classifier help?',
  question: 'Does the candidate improve recall without losing precision?',
  rationale: 'Decide whether to replace the current baseline.',
  hypothesis: 'The candidate catches more mislabeled requests.',
  method: ['Run the frozen baseline', 'Run the candidate', 'Compare held-out results'],
  baseline: 'The existing deterministic rules',
  metric: 'Recall at fixed precision',
  successCriteria: ['Recall increases by at least 5 points.'],
  research: [{ title: 'Prior results', url: 'https://example.org/paper' }],
  dataRequirements: [
    {
      id: 'eval',
      label: 'Held-out tickets',
      role: 'evaluation',
      format: 'csv',
      columns: ['text', 'label'],
      labelColumn: 'label',
      minRows: 10,
    },
  ],
  limits: { wallMinutes: 15, maxTokens: 10_000, maxAttempts: 2 },
  turnaround: 'Within an hour',
  deliverables: ['A results report', 'Reproducible code'],
};
const ready = () => ({
  id: requestId,
  workflow: { state: 'ready' },
  contract: {
    id: 'contract_fixture',
    version: 7,
    plan,
    price: { amountCents: 500, currency: 'usd' },
    datasets: [
      { requirementId: 'eval', filename: 'evaluation.csv', validatedAt: '2026-10-13T00:00:00Z' },
    ],
  },
});
interface Call {
  url: string;
  init: RequestInit;
}
type Reply = { status?: number; body?: unknown };
type Handler = (call: Call) => Promise<Reply> | Reply;
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
};

function boot(handler: Handler, options: { fragment?: string; id?: string } = {}) {
  const calls: Call[] = [];
  const page = new JSDOM(customerPage(options.id || requestId), {
    url:
      'https://merv.example/customer-experiments/r/' +
      encodeURIComponent(options.id || requestId) +
      (options.fragment ?? '#token=private-fixture'),
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, 'crypto', { value: webcrypto });
      Object.defineProperty(window, 'fetch', {
        value: async (url: string, init: RequestInit = {}) => {
          const call = { url, init };
          calls.push(call);
          const reply = await handler(call);
          return {
            ok: (reply.status || 200) < 400,
            status: reply.status || 200,
            json: async () => reply.body,
          };
        },
      });
    },
  });
  return { page, document: page.window.document, calls };
}

test('customer credential is removed from URL and sent only as a bearer header to its request', async (t) => {
  const { page, document, calls } = boot(() => ({ body: ready() }));
  t.after(() => page.window.close());
  await settle();
  assert.equal(page.window.location.hash, '');
  assert.equal(
    page.window.sessionStorage.getItem('merv:customer-experiment:' + requestId),
    'private-fixture',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, base);
  assert.equal(
    (calls[0].init.headers as Record<string, string>).Authorization,
    'Bearer private-fixture',
  );
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  assert.doesNotMatch(document.body.textContent || '', /private-fixture/);
  assert.match(document.body.textContent || '', /Held-out tickets/);
  assert.match(document.body.textContent || '', /Validated/);
  assert.match(document.body.textContent || '', /15 minutes/);
  assert.equal(document.querySelector<HTMLInputElement>('input[type=file]')?.accept, '.csv');
});

test('a page without a private link makes no request and cannot approve an experiment', async (t) => {
  const { page, document, calls } = boot(() => ({ body: ready() }), { fragment: '' });
  t.after(() => page.window.close());
  await settle();
  assert.equal(calls.length, 0);
  assert.match(document.body.textContent || '', /Open your private experiment link/);
  assert.equal(document.querySelector('form'), null);
});

test('HTML serialization cannot terminate script and both inline assets have exact CSP hashes', async (t) => {
  const attack = '</script><script>window.compromised=true</script>&\u2028';
  const html = customerPage(attack);
  const { page, document, calls } = boot(() => ({ body: { workflow: { state: 'planning' } } }), {
    id: attack,
  });
  t.after(() => page.window.close());
  await settle();
  assert.equal(document.scripts.length, 1);
  assert.equal((page.window as unknown as Record<string, unknown>).compromised, undefined);
  assert.equal(calls[0].url, '/customer-experiments/requests/' + encodeURIComponent(attack));
  assert.doesNotMatch(html, /<script>window\.compromised/);
  const policy = document
    .querySelector('meta[http-equiv="Content-Security-Policy"]')!
    .getAttribute('content')!;
  for (const node of [document.scripts[0], document.querySelector('style')!]) {
    const hash = createHash('sha256').update(node.textContent!).digest('base64');
    assert.ok(policy.includes("'sha256-" + hash + "'"));
  }
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
});

test('customer and agent content renders as text and dangerous research URLs never become links', async (t) => {
  const data = ready();
  data.contract.plan = {
    ...plan,
    title: '<img src=x onerror="window.compromised=true">',
    research: [{ title: '<svg onload=alert(1)>', url: 'javascript:alert(1)' }],
  };
  const { page, document } = boot(() => ({ body: data }));
  t.after(() => page.window.close());
  await settle();
  assert.match(document.querySelector('h1')!.textContent!, /<img/);
  assert.equal(document.querySelector('img'), null);
  assert.equal(document.querySelector('svg'), null);
  assert.equal(document.querySelector('a[href^="javascript:"]'), null);
  assert.equal((page.window as unknown as Record<string, unknown>).compromised, undefined);
});

test('approval submits the displayed version and email before checkout; checkout failure never marks execution paid', async (t) => {
  let accepted = false;
  const { page, document, calls } = boot((call) => {
    if (call.url.endsWith('/accept')) {
      accepted = true;
      return { body: {} };
    }
    if (call.url.endsWith('/checkout')) {
      assert.equal(accepted, true);
      return { status: 503, body: { error: { message: 'Payment setup is not ready.' } } };
    }
    return { body: { ...ready(), workflow: { state: accepted ? 'awaiting_payment' : 'ready' } } };
  });
  t.after(() => page.window.close());
  await settle();
  const form = document.querySelector('form')!;
  const email = document.querySelector<HTMLInputElement>('#email')!;
  email.value = 'customer@example.com';
  const checkbox = document.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new page.window.Event('change'));
  form.dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(
    calls
      .filter((call) => call.init.method === 'POST')
      .map((call) => [call.url, JSON.parse(call.init.body as string)]),
    [
      [base + '/accept', { contractVersion: 7, email: 'customer@example.com' }],
      [base + '/checkout', { contractVersion: 7, email: 'customer@example.com' }],
    ],
  );
  assert.match(document.body.textContent || '', /Payment setup is not ready/);
  assert.match(document.body.textContent || '', /Awaiting payment/);
  assert.equal(
    document.querySelector('input[type=checkbox]'),
    null,
    'accepted plan is not approved twice',
  );
  assert.equal(document.querySelector('button[type=submit]')!.textContent, 'Continue to payment');
  assert.doesNotMatch(document.querySelector('#app')!.textContent || '', /Payment is confirmed/);
});

test('unaccepted plan cannot be submitted without explicit human consent', async (t) => {
  const { page, document, calls } = boot(() => ({ body: ready() }));
  t.after(() => page.window.close());
  await settle();
  document.querySelector<HTMLInputElement>('#email')!.value = 'customer@example.com';
  document
    .querySelector('form')!
    .dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(calls.length, 1);
});

test('execution and review use server state, hide uploads and checkout, and expose completed findings', async (t) => {
  for (const state of ['running', 'finalizing', 'results_review', 'complete']) {
    const { page, document } = boot(() => ({
      body: {
        ...ready(),
        workflow: { state },
        submission: { summary: 'Recall increased by 7 points.' },
      },
    }));
    t.after(() => page.window.close());
    await settle();
    assert.equal(document.querySelector('form'), null);
    assert.equal(document.querySelector('input[type=file]'), null);
    assert.match(document.body.textContent || '', /Recall increased by 7 points/);
    assert.match(
      document.querySelector('[aria-current=step]')!.textContent!,
      state === 'complete' ? /Results/ : /Run/,
    );
  }
});

test('a rejected private link stops polling and clears only its own stored credential', async (t) => {
  const { page, document, calls } = boot(() => ({ status: 403, body: {} }));
  t.after(() => page.window.close());
  page.window.sessionStorage.setItem('merv:customer-experiment:another', 'keep-me');
  await settle();
  assert.equal(page.window.sessionStorage.getItem('merv:customer-experiment:' + requestId), null);
  assert.equal(page.window.sessionStorage.getItem('merv:customer-experiment:another'), 'keep-me');
  assert.match(document.body.textContent || '', /invalid or has expired/);
  page.window.document.dispatchEvent(new page.window.Event('visibilitychange'));
  await settle();
  assert.equal(calls.length, 1);
});

test('upload pins requirement and digest, excludes the customer token from storage, and waits for validation', async (t) => {
  let received = false;
  const bytes = Buffer.from('text,label\nhello,positive\n');
  const draft = { ...ready(), workflow: { state: 'planning' }, contract: null, draft: plan };
  const { page, document, calls } = boot((call) => {
    if (call.url === base + '/uploads')
      return {
        body: {
          uploadId: 'upload_1',
          url: 'https://storage.example/signed-upload',
          headers: { 'Content-Type': 'text/csv' },
        },
      };
    if (call.url === 'https://storage.example/signed-upload') return { body: {} };
    if (call.url === base + '/uploads/upload_1/complete') {
      received = true;
      return { body: {} };
    }
    return {
      body: {
        ...draft,
        uploads: received
          ? [{ requirementId: 'eval', filename: 'evaluation.csv', status: 'validating' }]
          : [],
      },
    };
  });
  t.after(() => page.window.close());
  await settle();
  const file = new page.window.File([bytes], 'evaluation.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: [file] });
  input.dispatchEvent(new page.window.Event('change'));
  await settle();
  const begin = calls.find((call) => call.url === base + '/uploads')!;
  assert.deepEqual(JSON.parse(begin.init.body as string), {
    requirementId: 'eval',
    filename: 'evaluation.csv',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mediaType: 'text/csv',
  });
  const transfer = calls.find((call) => call.url === 'https://storage.example/signed-upload')!;
  assert.equal(transfer.init.method, 'PUT');
  assert.equal(transfer.init.credentials, 'omit');
  assert.equal((transfer.init.headers as Record<string, string>).Authorization, undefined);
  assert.equal(calls.filter((call) => call.url.endsWith('/complete')).length, 1);
  assert.match(document.querySelector('#app')!.textContent!, /validating/);
  assert.equal(
    document.querySelector('form'),
    null,
    'received files are not permission to approve',
  );
});

test('a changed plan rejects old approval, clears consent, and never opens checkout for that version', async (t) => {
  let revised = false;
  const { page, document, calls } = boot((call) => {
    if (call.url.endsWith('/accept')) {
      revised = true;
      return { status: 409, body: { message: 'The plan has changed. Review the latest version.' } };
    }
    const data = ready();
    if (revised) data.contract.version = 8;
    return { body: data };
  });
  t.after(() => page.window.close());
  await settle();
  document.querySelector<HTMLInputElement>('#email')!.value = 'customer@example.com';
  const consent = document.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  consent.checked = true;
  consent.dispatchEvent(new page.window.Event('change'));
  document
    .querySelector('form')!
    .dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(
    calls.some((call) => call.url.endsWith('/checkout')),
    false,
  );
  assert.equal(document.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked, false);
  assert.match(document.querySelector('#app')!.textContent!, /Plan version8/);
  assert.match(document.querySelector('#notice')!.textContent!, /plan has changed/);
});

test('protected result collection downloads exchange the bearer credential for a signed file URL', async (t) => {
  const { page, document, calls } = boot((call) => {
    if (call.url === base + '/artifacts/artifact_report?fileName=reports%2Fresult.csv')
      return { body: { download: { url: 'https://storage.example/signed-result' } } };
    return {
      body: {
        ...ready(),
        workflow: { state: 'complete' },
        result: {
          summary: 'The candidate improved recall.',
          artifacts: [
            {
              id: 'artifact_report',
              title: 'Results',
              url: 'https://merv.example' + base + '/artifacts/artifact_report',
              files: [{ name: 'reports/result.csv' }],
            },
          ],
        },
      },
    };
  });
  t.after(() => page.window.close());
  await settle();
  const destinations: string[] = [];
  Object.defineProperty(page.window, 'open', {
    value: () => ({
      opener: page.window,
      location: { replace: (url: string) => destinations.push(url) },
      close() {},
    }),
  });
  const button = document.querySelector<HTMLButtonElement>('button.artifact')!;
  assert.equal(button.textContent, 'Results / reports/result.csv');
  button.click();
  await settle();
  assert.deepEqual(destinations, ['https://storage.example/signed-result']);
  const request = calls.find((call) => call.url.includes('/artifacts/'))!;
  assert.equal(
    (request.init.headers as Record<string, string>).Authorization,
    'Bearer private-fixture',
  );
  assert.ok(!destinations[0].includes('private-fixture'));
  assert.equal(document.querySelector('a[href*="private-fixture"]'), null);
});

test('unavailable checkout and upload adapters leave the plan visible without offering broken actions', async (t) => {
  const { page, document, calls } = boot(() => ({
    body: { ...ready(), checkoutAvailable: false, uploadAvailable: false },
  }));
  t.after(() => page.window.close());
  await settle();
  assert.equal(document.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled, true);
  assert.equal(document.querySelector<HTMLInputElement>('input[type=file]')!.disabled, true);
  assert.match(document.querySelector('#app')!.textContent!, /Checkout is temporarily unavailable/);
  assert.match(document.querySelector('#app')!.textContent!, /Uploads are temporarily unavailable/);
  assert.equal(calls.length, 1);
});

test('an already-present immutable upload still completes server validation on retry', async (t) => {
  let completed = false;
  const bytes = Buffer.from('text,label\none,positive\n');
  const { page, document, calls } = boot((call) => {
    if (call.url === base + '/uploads')
      return {
        body: {
          uploadId: 'retry_upload',
          url: 'https://storage.example/already-present',
          headers: { 'If-None-Match': '*' },
        },
      };
    if (call.url === 'https://storage.example/already-present') return { status: 412, body: {} };
    if (call.url === base + '/uploads/retry_upload/complete') {
      completed = true;
      return { body: { status: 'validated' } };
    }
    return {
      body: {
        ...ready(),
        workflow: { state: 'planning' },
        contract: null,
        draft: plan,
        uploads: completed
          ? [{ requirementId: 'eval', filename: 'evaluation.csv', status: 'validated' }]
          : [],
      },
    };
  });
  t.after(() => page.window.close());
  await settle();
  const file = new page.window.File([bytes], 'evaluation.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: [file] });
  input.dispatchEvent(new page.window.Event('change'));
  await settle();
  assert.equal(completed, true);
  assert.equal(calls.filter((call) => call.url.endsWith('/complete')).length, 1);
  assert.match(document.querySelector('#app')!.textContent!, /validated/);
  assert.equal(document.querySelector('form'), null, 'the server still owns readiness');
});
