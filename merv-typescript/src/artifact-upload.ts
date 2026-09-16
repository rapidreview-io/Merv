import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { check, MervError, type Artifact, type ArtifactInput } from '@merv/contracts';

const maxBytes = 2_000_000;
const mediaTypes: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
};

/** The client reads the file; the server never gains a filesystem-path capability. */
export function artifactFile(file: string, title?: string, mediaType?: string): ArtifactInput {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    check(
      stat.isFile() && stat.size > 0 && stat.size <= maxBytes,
      'artifact_file',
      'Choose a regular nonempty file of at most 2 MB',
    );
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0,
      count = 0;
    do {
      count = readSync(fd, bytes, size, bytes.length - size, null);
      size += count;
    } while (count && size < bytes.length);
    check(size > 0 && size <= maxBytes, 'artifact_file', 'Artifact file exceeds the 2 MB limit');
    return {
      title: title ?? basename(file),
      content: bytes.subarray(0, size).toString('base64'),
      encoding: 'base64',
      mediaType: mediaType ?? mediaTypes[extname(file).toLowerCase()] ?? 'application/octet-stream',
    };
  } finally {
    closeSync(fd);
  }
}

/** Upload once through the normal MCP policy, including session tool restrictions. */
export async function uploadArtifact(input: {
  url: string;
  file: string;
  token: string;
  projectId?: string;
  title?: string;
  mediaType?: string;
}): Promise<Artifact> {
  const url = new URL(input.url);
  check(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))),
    'artifact_url',
    'Use HTTPS or a loopback HTTP server URL without credentials or query parameters',
  );
  check(
    input.token.trim().length > 0 && !/[\r\n]/.test(input.token),
    'artifact_token',
    'A valid bearer credential is required',
  );
  const artifact = artifactFile(input.file, input.title, input.mediaType);
  const client = new Client({ name: 'merv-file-upload', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', url), {
    requestInit: {
      redirect: 'error',
      headers: {
        authorization: `Bearer ${input.token}`,
        ...(input.projectId ? { 'x-merv-project-id': input.projectId } : {}),
      },
    },
  });
  try {
    await client.connect(transport, { timeout: 30_000 });
    const result = await client.callTool(
      { name: 'artifact.create', arguments: { ...artifact } },
      undefined,
      { timeout: 30_000 },
    );
    if (result.isError)
      throw new MervError(
        'artifact_upload_failed',
        'Merv refused the artifact; check the credential, assignment and file metadata',
      );
    const blocks = result.content as { type: string; text?: string }[];
    const text = blocks.find((block) => block.type === 'text')?.text;
    const receipt = text ? (JSON.parse(text) as Artifact) : null;
    const bytes = Buffer.from(artifact.content, 'base64');
    check(
      receipt &&
        typeof receipt.id === 'string' &&
        receipt.hash === createHash('sha256').update(bytes).digest('hex') &&
        receipt.size === bytes.length,
      'artifact_upload_failed',
      'Merv returned no matching artifact receipt',
    );
    return {
      id: receipt.id,
      projectId: receipt.projectId,
      createdBy: receipt.createdBy,
      title: receipt.title,
      mediaType: receipt.mediaType,
      hash: receipt.hash,
      size: receipt.size,
      createdAt: receipt.createdAt,
    };
  } catch (error) {
    if (error instanceof MervError) throw error;
    throw new MervError(
      'artifact_upload_failed',
      'Artifact upload did not return a verified receipt; it was not automatically retried',
    );
  } finally {
    await client.close().catch(() => {});
  }
}
