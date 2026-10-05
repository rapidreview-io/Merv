import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  check,
  CODE_BUNDLE_MAX_BYTES,
  MervError,
  type CodeProjectStatus,
  type CodeStoreOperation,
} from '@merv/contracts';

const run = promisify(execFile);

/**
 * Bring one ref of a local repository into the repository Code keeps for a project. The
 * operator's machine cuts the bundle, leaving out what the server already holds, and sends
 * it in parts; the server never learns a path on this machine and the repository is only
 * read. A history too large for one transfer is imported oldest first, a ref at a time.
 */
export async function importRepository(input: {
  url: string;
  repository: string;
  ref: string;
  token: string;
  projectId?: string;
  /** How long to wait for admission, which runs on the server after the last part. */
  timeoutMs?: number;
}): Promise<CodeStoreOperation> {
  const url = new URL(input.url);
  check(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))),
    'code_import_url',
    'Use HTTPS or a loopback HTTP server URL without credentials or query parameters',
  );
  check(
    input.token.trim().length > 0 && !/[\r\n]/.test(input.token),
    'code_import_token',
    'A valid bearer credential is required',
  );
  const headers = {
    authorization: `Bearer ${input.token}`,
    ...(input.projectId ? { 'x-merv-project-id': input.projectId } : {}),
  };
  const git = async (...args: string[]) =>
    (await run('git', ['-C', input.repository, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout
      .toString()
      .trim();
  const local = async (...args: string[]) =>
    await git(...args).catch(() => {
      throw new MervError(
        'code_import_ref',
        `${input.ref} is not a branch or tag of that repository`,
      );
    });
  const name = await local('rev-parse', '--verify', '--symbolic-full-name', input.ref);
  check(
    name.startsWith('refs/'),
    'code_import_ref',
    `${input.ref} is not a branch or tag of that repository`,
  );
  const tip = await local('rev-parse', '--verify', `${name}^{commit}`);

  const client = new Client({ name: 'merv-code-import', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', url), {
    requestInit: { redirect: 'error', headers },
  });
  const directory = mkdtempSync(join(tmpdir(), 'merv-code-import-'));
  try {
    await client.connect(transport, { timeout: 30_000 });
    const tool = async <T>(tool: string, args: Record<string, unknown>): Promise<T> => {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: 60_000,
      });
      const text = (result.content as { type: string; text?: string }[]).find(
        (block) => block.type === 'text',
      )?.text;
      if (result.isError || !text)
        throw new MervError(
          'code_import_refused',
          `Merv refused ${tool}: ${text ?? 'no reason given'}`,
        );
      return JSON.parse(text) as T;
    };
    const status = await tool<CodeProjectStatus>('code.status', {});
    check(status.store, 'code_store_unavailable', 'That server keeps no Code repositories', 503);
    check(
      !status.store.tips.includes(tip),
      'code_import_current',
      `The project’s repository already holds ${tip}`,
      409,
    );
    // Only commits this repository has too can be left out; the rest simply are not mentioned.
    const held: string[] = [];
    for (const kept of status.store.tips)
      if (
        await git('cat-file', '-e', `${kept}^{commit}`).then(
          () => true,
          () => false,
        )
      )
        held.push(`^${kept}`);
    const file = join(directory, 'bundle');
    await run('git', ['-C', input.repository, 'bundle', 'create', '--quiet', file, name, ...held]);
    const bytes = statSync(file).size;
    check(
      bytes <= CODE_BUNDLE_MAX_BYTES,
      'code_import_too_large',
      'This history is larger than one transfer may be; import an older branch or tag of it first',
    );
    const descriptor = openSync(file, 'r');
    try {
      const chunk = (offset: number, length: number) => {
        const buffer = Buffer.alloc(length);
        return buffer.subarray(0, readSync(descriptor, buffer, 0, length, offset));
      };
      const hash = createHash('sha256');
      for (let offset = 0; offset < bytes; offset += 1024 * 1024)
        hash.update(chunk(offset, 1024 * 1024));
      const sha256 = hash.digest('hex');
      let operation = await tool<CodeStoreOperation>('code.repository.import', {
        source: 'bundle',
        tip,
        bundle: { sha256, bytes },
        // The same bytes resume the same operation; another cut of the history is another.
        requestId: `code-import:${sha256.slice(0, 40)}`,
      });
      const call = async (path: string, init: RequestInit) => {
        const response = await fetch(new URL(`/code/v2/uploads/${operation.id}${path}`, url), {
          ...init,
          redirect: 'error',
          headers: { ...headers, ...init.headers },
          signal: AbortSignal.timeout(30_000),
        });
        const body = (await response.json()) as {
          received?: number;
          operation?: CodeStoreOperation;
          error?: { code: string; message: string };
        };
        if (!response.ok)
          throw new MervError(
            body.error?.code ?? 'code_import_failed',
            body.error?.message ?? 'The server refused the transfer',
            response.status,
          );
        return body;
      };
      for (let offset = operation.received; operation.phase === 'receiving' && offset < bytes;)
        offset = (
          await call(`/parts/${offset}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: chunk(offset, operation.partBytes),
          })
        ).received!;
      const deadline = Date.now() + (input.timeoutMs ?? 30 * 60_000);
      const json = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
      for (;;) {
        operation = (await call('/complete', json)).operation!;
        if (operation.status !== 'prepared') return operation;
        check(
          Date.now() < deadline,
          'code_import_pending',
          `The server is still admitting operation ${operation.id}; run the same command again to wait for it`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      closeSync(descriptor);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await client.close().catch(() => {});
  }
}
