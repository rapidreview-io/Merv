import assert from 'node:assert/strict';
import { register } from 'tsx/esm/api';
import test from 'node:test';
import { releaseEntry, releaseId } from './hosted-release.mjs';
register();
const { applicationStatus, applicationInventory, probe } =
  await import('./hosted-sandboxes-probe.mjs');
const provider = { settings: { account_id: 'a'.repeat(32), application_id: 'b'.repeat(36) } };
const credential = { cloudflare_api_token: 'secret' };
const result = {
  id: provider.settings.application_id,
  version: 7,
  configuration: { image: 'registry@sha256:abc' },
  health: { errors: [] },
};

test('TS catalog IDs match the hosted manifest, including fixed arguments', async () => {
  const entry = releaseEntry('registry@sha256:' + 'a'.repeat(64), 'b'.repeat(64));
  entry.arguments = ['--serve'];
  assert.deepEqual(await probe({ MERV_RELEASES: JSON.stringify([entry]) }), [releaseId(entry)]);
  await assert.rejects(probe({ MERV_RELEASES: '[{}]' }));
});

test('native status retries transient GETs, checks identity, and returns only release facts', async () => {
  const calls = [],
    sleeps = [],
    statuses = [429, 503, 200];
  const status = await applicationStatus(provider, credential, {
    fetcher: async (url, options) => {
      calls.push([url, options]);
      return new Response(JSON.stringify({ success: true, result }), { status: statuses.shift() });
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(([url]) => url)).size, 1);
  assert.equal(status.image, result.configuration.image);
  assert.equal(status.keys, 0);
  assert.equal(status.ssh, false);
  for (const code of [401, 403, 404, 503]) {
    let count = 0;
    await assert.rejects(
      applicationStatus(provider, credential, {
        fetcher: async () => {
          count++;
          return new Response('do not log secrets', { status: code });
        },
        sleep: async () => {},
      }),
      new RegExp(`HTTP ${code}, attempt ${code === 503 ? 3 : 1}/3`),
    );
    assert.equal(count, code === 503 ? 3 : 1);
  }
  await assert.rejects(
    applicationStatus(provider, credential, {
      fetcher: async () => Response.json({ success: true, result: { ...result, id: 'other' } }),
    }),
    /identity/,
  );
});

test('native status cancels an expired request without retrying', async () => {
  let count = 0;
  const controller = new AbortController();
  const pending = applicationStatus(provider, credential, {
    signal: controller.signal,
    fetcher: async (_, { signal }) => {
      count++;
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
    },
  });
  controller.abort(new Error('deadline'));
  await assert.rejects(pending, /deadline/);
  assert.equal(count, 1);
});

const inventoryPage = (instances = [], durable_objects = [], result_info = { per_page: 100 }) => ({
  success: true,
  result: { instances, durable_objects },
  result_info,
});
test('native inventory proves empty despite positive healthy summary and reads every page', async () => {
  const calls = [];
  const pages = [
    inventoryPage([], [], { per_page: 100, next_page_token: 'page2' }),
    inventoryPage(),
  ];
  const actual = await applicationInventory(provider, credential, {
    fetcher: async (url, options) => {
      calls.push([url, options.method]);
      return Response.json(pages.shift());
    },
  });
  assert.deepEqual(actual, { empty: true, instances: 0, durableObjects: 0, pages: 2 });
  assert.ok(calls[1][0].includes('page_token=page2'));
  assert.ok(
    calls.every(
      ([url, method]) => url.includes('/containers/dash/applications/') && method === 'GET',
    ),
  );
  for (const page of [
    inventoryPage([
      { id: 'active', current_placement: { status: { container_status: 'running' } } },
    ]),
    inventoryPage([], [{ name: 'assigned', deployment_id: 'pending' }]),
    inventoryPage([{ id: 'starting' }]),
  ]) {
    assert.equal(
      (
        await applicationInventory(provider, credential, {
          fetcher: async () => Response.json(page),
        })
      ).empty,
      false,
    );
  }
});

test('native inventory rejects incomplete, unfamiliar, duplicate and endless pages', async () => {
  for (const page of [
    { success: false, result: { instances: [], durable_objects: [] }, result_info: {} },
    { success: true, result: { instances: [] }, result_info: {} },
    { ...inventoryPage(), result_info: null },
    { ...inventoryPage(), result_info: { has_more: true } },
    { ...inventoryPage(), result: { instances: [], durable_objects: [], pending: [] } },
    inventoryPage([{}]),
    inventoryPage([], [{}]),
    inventoryPage([{ id: 'same' }, { id: 'same' }]),
    inventoryPage([], [], { next_page_token: '' }),
    inventoryPage([], [], { per_page: '100' }),
  ])
    await assert.rejects(
      applicationInventory(provider, credential, { fetcher: async () => Response.json(page) }),
    );
  await assert.rejects(
    applicationInventory(provider, credential, {
      fetcher: async () => Response.json(inventoryPage([], [], { next_page_token: 'same' })),
    }),
    /pagination/,
  );
  let number = 0;
  await assert.rejects(
    applicationInventory(provider, credential, {
      fetcher: async () =>
        Response.json(inventoryPage([], [], { next_page_token: String(++number) })),
    }),
    /page limit/,
  );
  for (const status of [401, 403, 404, 503])
    await assert.rejects(
      applicationInventory(provider, credential, {
        fetcher: async () => new Response('private response', { status }),
        sleep: async () => {},
      }),
      new RegExp('HTTP ' + status),
    );
});
