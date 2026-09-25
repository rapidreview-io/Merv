/**
 * Sandboxes pre-flight for the QA plan (J7.0). The grant is read only from the environment
 * variable --token-env names, goes only to an https (or loopback http) URL, and every line this
 * prints has it redacted.
 *
 *   node dev_docs/qa/sbx-probe.mjs --url <sandboxes MCP url> --token-env <ENV> \
 *     [--min-memory-mb 6144] [--create]
 *
 * providers_list, sandbox_options (no filter, then min_memory_mb), spend_status; with --create,
 * sandbox_create on the cheapest offer with a trivial python job that releases the machine when
 * it ends, then job_status (long-polled with the cursor of the last answer) and sandbox_get until
 * it has stopped, then sandbox_events. Exits 1 when the job does not succeed or the machine
 * fails; a machine still up when the probe fails or runs past 20 minutes is deleted.
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
const token = (o['token-env'] && process.env[o['token-env']]) ?? '';
const url = URL.canParse(o.url ?? '') ? new URL(o.url) : undefined;
const loopback =
  url?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if (
  !(url?.protocol === 'https:' || loopback) ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  !/^[\x21-\x7e]+$/.test(token)
) {
  console.error(
    'Usage: sbx-probe.mjs --url <https or loopback MCP url> --token-env <ENV holding one printable token> [--min-memory-mb n] [--create]',
  );
  process.exit(2);
}
const redact = (text) => String(text).split(token).join('[redacted]');
process.on('uncaughtException', (error) => {
  console.error(redact(error?.stack ?? error));
  process.exit(1);
});
const client = new Client({ name: 'qa-sbx-probe', version: '1' });
const headers = { authorization: `Bearer ${token}` };
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
  console.log(redact(JSON.stringify(line)));
  if (response.isError) throw new Error(`${tool} failed`);
  return result;
};

let box;
const deadline = Date.now() + 20 * 60_000;
try {
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  await call('providers_list');
  const { offers = [] } = await call('sandbox_options');
  await call('sandbox_options', { min_memory_mb: Number(o['min-memory-mb']) });
  await call('spend_status');
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
    // job_status waits only when given the cursor of an earlier answer; without one it returns at once.
    const done = ['succeeded', 'failed', 'cancelled', 'timed_out'];
    let job;
    while (box.main_job_id && !done.includes(job?.state)) {
      if (Date.now() > deadline) throw new Error('Job never finished');
      const after = job?.cursor ? { after: job.cursor } : {};
      job = await call('job_status', { job_id: box.main_job_id, wait: 30, ...after });
    }
    while (!['stopped', 'failed'].includes(box.state)) {
      if (Date.now() > deadline) throw new Error('Sandbox did not release itself');
      await delay(10_000);
      box = await call('sandbox_get', { sandbox_id: box.id });
    }
    await call('sandbox_events', { sandbox_id: box.id });
    if (job?.state !== 'succeeded' || box.state === 'failed')
      throw new Error(`Job ${job?.state ?? 'never started'}, sandbox ${box.state}`);
  }
} catch (error) {
  process.exitCode = 1;
  console.error(redact(error.message));
  if (box && !['stopped', 'deleting'].includes(box.state))
    await call('sandbox_delete', { sandbox_id: box.id });
} finally {
  await client.close();
}
