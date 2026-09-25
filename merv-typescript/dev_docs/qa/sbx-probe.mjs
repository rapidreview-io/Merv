/**
 * Sandboxes pre-flight for the QA plan (J7.0). The grant is read only from the environment
 * variable --token-env names; every call prints one JSON line with the grant redacted.
 *
 *   node dev_docs/qa/sbx-probe.mjs --url <sandboxes MCP url> --token-env <ENV> \
 *     [--min-memory-mb 6144] [--create]
 *
 * providers_list, sandbox_options (no filter, then min_memory_mb), spend_status; with --create,
 * sandbox_create on the cheapest offer with a trivial python job that releases the machine when
 * it ends, then job_status and sandbox_get until it has stopped, then sandbox_events. A machine
 * still up when the probe fails or runs past 20 minutes is deleted.
 */
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { values: o } = parseArgs({
  options: {
    url: { type: 'string' },
    'token-env': { type: 'string' },
    'min-memory-mb': { type: 'string', default: '6144' },
    create: { type: 'boolean', default: false },
  },
});
const token = o['token-env'] && process.env[o['token-env']];
if (!o.url || !token) {
  console.error('Usage: sbx-probe.mjs --url <mcp url> --token-env <ENV> [--min-memory-mb n] [--create]');
  process.exit(2);
}
const client = new Client({ name: 'qa-sbx-probe', version: '1' });
const headers = { authorization: `Bearer ${token}` };
const transport = new StreamableHTTPClientTransport(new URL(o.url), { requestInit: { headers } });
await client.connect(transport);
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const call = async (tool, args = {}) => {
  const started = Date.now();
  const response = await client.callTool({ name: tool, arguments: args }, undefined, {
    timeout: 120_000,
  });
  const result = response.structuredContent ?? parse(response.content?.[0]?.text);
  const line = { at: new Date().toISOString(), tool, args, ms: Date.now() - started, result };
  if (response.isError) line.error = true;
  console.log(JSON.stringify(line).split(token).join('[redacted]'));
  if (response.isError) throw new Error(`${tool} failed`);
  return result;
};

await call('providers_list');
const { offers = [] } = await call('sandbox_options');
await call('sandbox_options', { min_memory_mb: Number(o['min-memory-mb']) });
await call('spend_status');
let box;
const deadline = Date.now() + 20 * 60_000;
try {
  if (o.create) {
    if (!offers.length) throw new Error('No offer to create a sandbox from');
    box = await call('sandbox_create', {
      provider: offers[0].provider,
      offer_id: offers[0].offer_id,
      name: 'qa5-probe',
      command: "python3 -c 'import os; print(os.cpu_count())'",
      job_name: 'qa5-probe',
      release_when_done: true,
    });
    while (box.state === 'provisioning' || (box.state === 'ready' && !box.main_job_id)) {
      if (Date.now() > deadline) throw new Error('Sandbox never became ready');
      box = await call('sandbox_get', { sandbox_id: box.id, wait: 30 });
    }
    const done = ['succeeded', 'failed', 'cancelled', 'timed_out'];
    for (let job; box.main_job_id && !done.includes(job?.state); ) {
      if (Date.now() > deadline) throw new Error('Job never finished');
      job = await call('job_status', { job_id: box.main_job_id, wait: 30 });
    }
    while (!['stopped', 'failed'].includes(box.state)) {
      if (Date.now() > deadline) throw new Error('Sandbox did not release itself');
      await delay(10_000);
      box = await call('sandbox_get', { sandbox_id: box.id });
    }
    await call('sandbox_events', { sandbox_id: box.id });
  }
} catch (error) {
  process.exitCode = 1;
  console.error(String(error.message).split(token).join('[redacted]'));
  if (box && !['stopped', 'deleting'].includes(box.state))
    await call('sandbox_delete', { sandbox_id: box.id });
} finally {
  await client.close();
}
