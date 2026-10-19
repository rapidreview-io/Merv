import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestBuckets, validateDataset } from '../packages/customer-experiments/src/data.js';
import type { DataRequirement } from '../packages/customer-experiments/src/types.js';

const requirement: DataRequirement = {
  id: 'evaluation',
  label: 'Held-out examples',
  role: 'evaluation',
  format: 'csv',
  columns: ['text', 'label'],
  labelColumn: 'label',
  minRows: 2,
};
test('tabular validation checks real rows, quoted CSV, labels, encoding and consistent JSONL schemas', () => {
  const first = validateDataset(
    Buffer.from('text,label\r\n"a,b",yes\r\n"two\nlines",no\r\n'),
    requirement,
  );
  assert.equal(first.rows, 2);
  assert.deepEqual(first.columns, ['text', 'label']);
  assert.equal(
    first.validationId,
    validateDataset(Buffer.from('text,label\r\n"a,b",yes\r\n"two\nlines",no\r\n'), requirement)
      .validationId,
  );
  for (const input of [
    'text,label\na,yes\nb,',
    'text,label\na,yes\nb,no,extra',
    'text,text\na,b\nc,d',
    'text,label\n"unterminated,yes',
    'text,label\n"quoted"garbage,no',
  ])
    assert.throws(() => validateDataset(Buffer.from(input), requirement));
  assert.throws(() => validateDataset(Buffer.from([255]), requirement));
  assert.throws(() => validateDataset(Buffer.from('text,label\na,yes\nb,\0'), requirement));
  const jsonl = { ...requirement, format: 'jsonl' as const };
  assert.equal(
    validateDataset(Buffer.from('{"text":"one","label":false}\n{"text":"two","label":0}\n'), jsonl)
      .rows,
    2,
  );
  assert.throws(() =>
    validateDataset(Buffer.from('{"text":"one","label":"yes"}\n{"text":"two"}'), jsonl),
  );
  assert.throws(() =>
    validateDataset(Buffer.from('{"text":"one","label":null}\n{"text":"two","label":{}}'), jsonl),
  );
  assert.throws(() => validateDataset(Buffer.from('[]\n[]'), jsonl));
});

test('request bucket provisioning blocks public access before allowing browser PUTs and never accepts a foreign bucket', async () => {
  const storage = new RequestBuckets({
    endpoint: 'https://s3.example.com',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    bucketPrefix: 'merv-customer',
    publicOrigin: 'https://merv.example.com',
  });
  const calls: { name: string; input: any }[] = [];
  const client = (storage as unknown as { client: { send: (cmd: any) => Promise<unknown> } })
    .client;
  client.send = async (cmd) => {
    calls.push({ name: cmd.constructor.name, input: cmd.input });
    return {};
  };
  const id = 'ce_' + 'a'.repeat(32);
  await storage.provision(id);
  assert.deepEqual(
    calls.map((c) => c.name),
    ['CreateBucketCommand', 'PutPublicAccessBlockCommand', 'PutBucketCorsCommand'],
  );
  assert.equal(calls[0]!.input.Bucket, 'merv-customer-' + 'a'.repeat(32));
  assert.deepEqual(calls[1]!.input.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    IgnorePublicAcls: true,
    BlockPublicPolicy: true,
    RestrictPublicBuckets: true,
  });
  assert.deepEqual(calls[2]!.input.CORSConfiguration.CORSRules[0].AllowedOrigins, [
    'https://merv.example.com',
  ]);
  client.send = async () => {
    throw Object.assign(new Error('foreign'), { name: 'BucketAlreadyExists' });
  };
  await assert.rejects(storage.provision(id), /foreign/);
  assert.throws(() => storage.bucket('../other'));
  await storage.close();
});

test('submission email includes the return URL and its own idempotency key', async (t) => {
  const { ResendResultMailer } = await import('../packages/customer-experiments/src/mail.js');
  let sent: { subject: string; text: string; to: string[] } | undefined;
  let key: string | null = null;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    key = new Headers(init.headers).get('Idempotency-Key');
    return new Response('{}', { status: 200 });
  });
  await new ResendResultMailer('fixture-key', 'Merv <merv@example.com>').send({
    to: 'customer@example.com',
    title: 'My experiment',
    url: 'https://merv.example/r/1#token=private',
    kind: 'submitted',
    idempotencyKey: 'request-submitted-payment',
  });
  assert.equal(sent!.subject, 'Experiment submitted: My experiment');
  assert.match(sent!.text, /Your experiment link/);
  assert.match(sent!.text, /https:\/\/merv.example\/r\/1#token=private/);
  assert.deepEqual(sent!.to, ['customer@example.com']);
  assert.equal(key, 'request-submitted-payment');
});
