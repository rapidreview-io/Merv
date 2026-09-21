import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * A worker the test plays step by step. It announces itself in a directory of its own under
 * the control directory, then performs the numbered steps it finds there: a tool call over
 * MCP with its session credential, a file written into the checkout, or a Git query of it.
 */
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const assignment = JSON.parse(prompt.slice(prompt.indexOf('Frozen assignment:') + 18).trim());
const directory = join(process.argv[2], `${Date.now()}-${process.pid}`);
mkdirSync(directory, { recursive: true });
const publish = (name, value) => {
  writeFileSync(join(directory, `${name}.tmp`), JSON.stringify(value));
  renameSync(join(directory, `${name}.tmp`), join(directory, name));
};
const client = new Client({ name: 'puppet-worker', version: '1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(process.env.MERV_MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${process.env.MERV_AGENT_SESSION_TOKEN}` } },
  }),
);
publish('ready.json', { cwd: process.cwd(), assignment });
for (let step = 1; ; step++) {
  const file = join(directory, `step-${step}.json`);
  while (!existsSync(file)) await delay(20);
  const { kind, ...input } = JSON.parse(readFileSync(file, 'utf8'));
  let result;
  try {
    if (kind === 'tool') {
      const answer = await client.callTool({ name: input.name, arguments: input.input });
      const text = answer.content.find((item) => item.type === 'text').text;
      result = answer.isError ? { ok: false, error: text } : { ok: true, value: JSON.parse(text) };
    } else if (kind === 'write') {
      mkdirSync(dirname(join(process.cwd(), input.path)), { recursive: true });
      if (input.content === null) rmSync(join(process.cwd(), input.path), { force: true });
      else writeFileSync(join(process.cwd(), input.path), input.content);
      result = { ok: true, value: null };
    } else if (kind === 'git')
      result = {
        ok: true,
        value: execFileSync('git', input.args, { encoding: 'utf8' }).trim(),
      };
    else if (kind === 'read')
      result = {
        ok: true,
        value: existsSync(join(process.cwd(), input.path))
          ? readFileSync(join(process.cwd(), input.path), 'utf8')
          : null,
      };
    else result = { ok: false, error: `unknown step ${kind}` };
  } catch (error) {
    result = { ok: false, error: String(error?.message ?? error) };
  }
  publish(`step-${step}.result.json`, result);
}
