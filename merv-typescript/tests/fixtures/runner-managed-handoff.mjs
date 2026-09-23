import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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
// The server must close the completed Session and Runner must stop this process.
setInterval(() => {}, 1000);
