import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createApp } from '../../src/app.js';
import { stateConfig } from './state.js';

/** Real Board, PostgreSQL, authorization and HTTP/MCP, without unrelated workflow services.
 * Cross-domain Board tests keep the full httpApp fixture. Every call gets its own schema and port. */
export async function boardApp(
  t: TestContext,
  prefix: string,
  { artifacts = false }: { artifacts?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  t.after(async () => {
    await app?.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'scope', name: '@merv/scope' },
        { id: 'identity', name: '@merv/identity' },
        { id: 'tools', name: '@merv/api/tools-plugin' },
        { id: 'api', name: '@merv/api', config: { host: '127.0.0.1', port: 0 } },
        { id: 'board', name: '@merv/board' },
        { id: 'board-tools', name: '@merv/board/tools' },
        ...(artifacts
          ? [
              { id: 'blobs', name: '@merv/blobs', config: { root: join(directory, 'blobs') } },
              { id: 'artifacts', name: '@merv/artifacts' },
              { id: 'artifacts-tools', name: '@merv/artifacts/tools' },
            ]
          : []),
      ],
    },
  });
  const url = app.ctx.api.url;
  const tool = async (name: string, token: string, input: unknown = {}) => {
    const response = await fetch(`${url}/tools/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return { app, directory, tool };
}
