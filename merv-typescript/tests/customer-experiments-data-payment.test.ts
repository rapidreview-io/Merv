import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { RequestBuckets, validateDataset } from '../packages/customer-experiments/src/data.js';
import { StripePayments } from '../packages/customer-experiments/src/payment.js';
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

const secret = 'whsec_test_customer';
const payments = new StripePayments({
  secretKey: 'sk_test_not_a_live_key',
  webhookSecret: secret,
  publicOrigin: 'https://merv.example.com',
  live: false,
});
const stripe = new Stripe('sk_test_not_a_live_key');
function event(overrides: Record<string, unknown> = {}, session: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'evt_customer',
    object: 'event',
    livemode: false,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_customer',
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_customer',
        amount_total: 500,
        currency: 'usd',
        client_reference_id: 'ce_request',
        metadata: {
          product: 'merv-customer-experiment-v1',
          requestId: 'ce_request',
          contractHash: 'fixed-contract',
        },
        ...session,
      },
    },
    ...overrides,
  });
}
function signed(payload: string, timestamp = Math.floor(Date.now() / 1000)) {
  return stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
}
test('only authentic paid same-mode checkout events can release the exact referenced contract', () => {
  const payload = event();
  assert.deepEqual(payments.verify(Buffer.from(payload), signed(payload)), {
    eventId: 'evt_customer',
    requestId: 'ce_request',
    contractHash: 'fixed-contract',
    checkoutId: 'cs_test_customer',
    paymentId: 'pi_customer',
    amountCents: 500,
    currency: 'usd',
  });
  const unpaid = event({}, { payment_status: 'unpaid' });
  assert.equal(payments.verify(Buffer.from(unpaid), signed(unpaid)), null);
  const other = event({ type: 'payment_intent.succeeded' });
  assert.equal(payments.verify(Buffer.from(other), signed(other)), null);
  const live = event({ livemode: true });
  assert.throws(() => payments.verify(Buffer.from(live), signed(live)), /wrong payment mode/);
  assert.throws(() => payments.verify(Buffer.from(payload + ' '), signed(payload)), /signature/);
  assert.throws(() => payments.verify(Buffer.from(payload), signed(payload, 1)), /signature/);
  const mismatch = event({}, { client_reference_id: 'some-other-request' });
  assert.throws(() => payments.verify(Buffer.from(mismatch), signed(mismatch)), /references/);
  assert.throws(
    () =>
      new StripePayments({
        secretKey: 'sk_live_disallowed',
        webhookSecret: secret,
        publicOrigin: 'https://merv.example.com',
        live: false,
      }),
    /payment mode/,
  );
});
