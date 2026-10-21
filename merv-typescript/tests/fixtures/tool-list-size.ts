/** Measure the real operator MCP listing against an isolated test database schema. */
import { createHash } from 'node:crypto';
import { ToolRegistry, isRemoteTool } from '../../packages/api/src/registry.js';
import { declaration } from '../../packages/scripts/src/declare.js';
import { constraints, expanded } from './tool-schema.js';
import type { SessionToolPolicy } from '@merv/contracts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from './app.js';
import { hostConfig } from './admin.js';
import host from '@merv/sandboxes/host';
import { nisaTools } from '../../packages/nisa/src/tools.js';
import type { Nisa } from '../../packages/nisa/src/types.js';
import { webTools } from '../../packages/web/src/tools.js';
import type { Web } from '../../packages/web/src/types.js';

const directory = mkdtempSync(join(tmpdir(), 'merv-tool-list-size-'));
const app = await createApp({ directory, api: true, port: 0, feed: true });
const client = new Client({ name: 'tool-list-size', version: '1.0.0' });
// These services are never called: only their production definitions are registered.
const nisa = new Proxy({} as Nisa, {
  get: () => () => {
    throw new Error('Measurement only');
  },
});
const web = { reads: true } as Web;
for (const tool of nisaTools(nisa)) {
  if ('inputSchema' in tool) app.ctx.tools.register(tool);
  else app.ctx.tools.noun(tool.name, tool);
}
const webTool = webTools(web);
app.ctx.tools.noun(webTool.name, webTool);
process.env.MERV_TOOL_SIZE_VAULT_KEY = Buffer.alloc(32, 7).toString('base64url');
const sandbox = await hostConfig('MERV_TOOL_SIZE_VAULT_KEY', { registerTools: true });
const fiber = app.ctx.plugin(host, sandbox.config);
try {
  await fiber.await();
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Tool listing measurement',
    actorName: 'Operator',
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${boot.token}` } },
    }),
  );
  const listing = await client.listTools();
  // Optional snapshot contains public tool metadata only, never credentials.
  if (process.argv[2] && !process.argv[2].startsWith('--'))
    writeFileSync(process.argv[2], JSON.stringify(listing, null, 2) + '\n');
  if (process.argv.includes('--metadata')) {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const canonical = (value: unknown): string =>
      JSON.stringify(value, (_key, node) =>
        node && typeof node === 'object' && !Array.isArray(node)
          ? Object.fromEntries(Object.entries(node).sort(([a], [b]) => a.localeCompare(b)))
          : node,
      );
    const workers = new ToolRegistry({ require: async () => ({ role: 'operator' }) } as never);
    for (const tool of await app.ctx.tools.list()) if (!isRemoteTool(tool)) workers.register(tool);
    workers.registerSessionPolicy({ allowsTool: async () => true } as unknown as SessionToolPolicy);
    const caller = { actorId: boot.actor.id, projectId: boot.project.id };
    const worker = await workers.describe({ ...caller, session: { id: 'metadata' } }, true);
    const scripts = await app.ctx.tools.describe(caller, true, { compact: false });
    console.log(
      'METADATA\t' +
        JSON.stringify({
          workers: Object.fromEntries(
            worker.map((tool) => [tool.name, hash(JSON.stringify(tool))]),
          ),
          scripts: Object.fromEntries(
            scripts.map((tool) => [
              tool.name,
              hash(declaration(tool, true, app.ctx.tools.tool(tool.name)?.actions)),
            ]),
          ),
          schemas: Object.fromEntries(
            listing.tools.map((tool) => [
              tool.name,
              hash(canonical(constraints(expanded(tool.inputSchema)))),
            ]),
          ),
        }),
    );
  }
  console.log('tool\tJSON characters\tdescription\tinputSchema');
  for (const tool of listing.tools)
    console.log(
      [
        tool.name,
        JSON.stringify(tool).length,
        tool.description?.length ?? 0,
        JSON.stringify(tool.inputSchema).length,
      ].join('\t'),
    );
  console.log(`TOTAL\t${JSON.stringify(listing).length}\t${listing.tools.length} tools`);
} finally {
  await client.close();
  await fiber.dispose();
  await app.stop();
  delete process.env.MERV_TOOL_SIZE_VAULT_KEY;
  rmSync(sandbox.dataDir, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
}
