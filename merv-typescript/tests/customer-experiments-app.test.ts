import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { customerDocument } from '../packages/customer-experiments/src/customer-app.js';
import { customerPage } from '../packages/customer-experiments/src/customer-page.js';
import type { CustomerService } from '../packages/customer-experiments/src/service.js';
import { UiRegistry } from '../packages/ui/src/index.js';

const ID = `ce_${'b'.repeat(32)}`;
/** A service whose request runs on service_experiment@`version`, or has no experiment yet. */
const service = (version: number | null) =>
  ({
    store: {
      state: { ambient: undefined },
      get: async () => ({
        id: ID,
        projectId: 'p1',
        ...(version === null ? {} : { experimentId: 'exp_1' }),
      }),
    },
    caller: async () => ({ projectId: 'p1' }),
    domain: { get: async () => ({ workflow: { version } }) },
  }) as unknown as CustomerService;
const app = async () => '<!doctype html><title>Merv | Experiment</title>';

test('v3 requests open the built customer app; v1, v2 and unready requests keep their page', async () => {
  assert.equal(await customerDocument(service(3), ID, app), await app());
  for (const version of [1, 2, null])
    assert.equal(await customerDocument(service(version), ID, app), customerPage(ID));
  // Without the UI loaded or built, a v3 request still gets a page.
  assert.equal(await customerDocument(service(3), ID), customerPage(ID));
  assert.equal(await customerDocument(service(3), ID, async () => null), customerPage(ID));
  // A request the store does not know is not told apart from one on the old page.
  const missing = {
    ...service(3),
    store: { get: async () => Promise.reject(new Error('not found')) },
  } as unknown as CustomerService;
  assert.equal(await customerDocument(missing, ID, app), customerPage(ID));
});

test('the UI hands out the customer page it built, or null before a build', async () => {
  const assets = mkdtempSync(join(tmpdir(), 'merv-ui-'));
  const ui = new UiRegistry(assets);
  assert.equal(await ui.document('customer'), null);
  writeFileSync(join(assets, 'customer.html'), '<div id="root"></div>');
  assert.equal(await ui.document('customer'), '<div id="root"></div>');
  await assert.rejects(ui.document('index' as 'customer'));
});
