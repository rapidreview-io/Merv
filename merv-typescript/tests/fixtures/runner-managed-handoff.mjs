import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const prompt = (await Array.fromAsync(process.stdin)).join('');
const token = process.env.MERV_AGENT_SESSION_TOKEN;
assert.match(token ?? '', /^ms_[A-Za-z0-9_-]{43}$/);
const client = new Client({ name: 'runner-managed-handoff-fixture', version: '1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(process.env.MERV_MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);
const result = await client.callTool({ name: 'step.finish', arguments: {} });
assert.notEqual(result.isError, true);
await client.close();
// Like `codex exec --json` (QA, 2026-09-25): a closing message after the handoff, and only then
// what the turn spent, well after the server has closed the session.
await delay(2000);
process.stdout.write(
  '{"type":"item.completed","item":{"id":"item_9","type":"agent_message","text":"Handed off."}}\n' +
    '{"type":"turn.completed","usage":{"input_tokens":175540,"cached_input_tokens":122112,"output_tokens":1488}}\n',
);
// One that lingers after its turn must be stopped by Runner.
if (prompt.includes('linger')) setInterval(() => {}, 1000);
