import { MervError } from '@merv/contracts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Transform, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { stopped, type GitResult } from '../git.js';
import type { CodeRepositories } from './repository.js';

const MAX_PUSH = 2 * 1024 ** 3;
const MAX_FETCH = 32 * 1024 ** 2;
const MAX_REPLY = 4 * 1024 ** 2;
const MAX_HEADERS = 64 * 1024;
const CHECK_ROOM = 16 * 1024 ** 2;
const failed = () => new MervError('code_git_failed', 'Git returned an invalid HTTP response', 502);

/** CGI headers only; Git owns every byte of the protocol body. */
function headers(buffer: Buffer) {
  const crlf = buffer.indexOf('\r\n\r\n');
  const lf = buffer.indexOf('\n\n');
  const index = crlf < 0 ? lf : lf < 0 ? crlf : Math.min(crlf, lf);
  if (index < 0) {
    if (buffer.length > MAX_HEADERS) throw failed();
    return null;
  }
  if (index > MAX_HEADERS) throw failed();
  let status = 200;
  const values: Record<string, string> = {};
  for (const line of buffer.subarray(0, index).toString('latin1').split(/\r?\n/)) {
    const field = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(line);
    if (!field || /[\r\n\0]/.test(field[2]!)) throw failed();
    const name = field[1]!.toLowerCase();
    if (name === 'status') {
      const code = /^([1-5][0-9]{2})(?: .*)?$/.exec(field[2]!);
      if (!code) throw failed();
      status = Number(code[1]);
    } else values[name] = field[2]!;
  }
  return { status, values, body: buffer.subarray(index + (index === crlf ? 4 : 2)) };
}

/** A bounded CGI preamble followed by response writes with stream backpressure. */
class CgiResponse extends Writable {
  private pending = Buffer.alloc(0);
  private parsed = false;
  constructor(private readonly response: ServerResponse) {
    super();
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    try {
      let body = chunk;
      if (!this.parsed) {
        this.pending = Buffer.concat([this.pending, chunk]);
        const found = headers(this.pending);
        if (!found) return callback();
        this.parsed = true;
        this.pending = Buffer.alloc(0);
        this.response.writeHead(found.status, found.values);
        body = found.body;
      }
      if (!body.length) return callback();
      this.response.write(body, callback);
    } catch (error) {
      callback(error as Error);
    }
  }
  override _final(callback: (error?: Error | null) => void) {
    callback(this.parsed ? undefined : failed());
  }
}

/** Authenticated, route-validated native smart HTTP through Git's own CGI backend.
 * Push replies wait for the caller's ref-journal reconciliation, including a failed receiver.
 * Upload-pack streams without collecting its pack or interpreting Git packet framing.
 */
export async function gitHttp(
  repositories: CodeRepositories,
  projectId: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: {
    hooksPath?: string;
    socketPath?: string;
    durableOwner?: string;
    beforeReply?: () => Promise<void>;
  } = {},
): Promise<void> {
  const route = /^\/git\/[^/]+\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
    url.pathname,
  )?.[1];
  if (!route) throw new MervError('not_found', 'Unknown Git endpoint', 404);
  const push = req.method === 'POST' && route === 'git-receive-pack';
  const maximum = push ? MAX_PUSH : MAX_FETCH;
  const controller = new AbortController();
  let inputError: Error | undefined;
  let outputError: Error | undefined;
  let bytes = 0;
  let checked = -CHECK_ROOM;
  const input = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maximum) {
        inputError = new MervError(
          'body_too_large',
          'Git request exceeds the admission limit',
          413,
        );
        return callback(inputError);
      }
      const room = push && bytes - checked >= CHECK_ROOM;
      if (room) checked = bytes;
      (room ? repositories.assertRoom(projectId, chunk.length) : Promise.resolve()).then(
        () => callback(null, chunk),
        (error: Error) => {
          inputError = error;
          callback(error);
        },
      );
    },
  });
  const output = push ? undefined : new CgiResponse(res);
  const abort = () => controller.abort();
  const requestError = (error: Error) => {
    inputError ??= error;
    input.destroy(error);
    abort();
  };
  input.on('error', (error) => {
    inputError ??= error;
    abort();
  });
  output?.on('error', (error) => {
    outputError ??= error;
    abort();
  });
  req.once('error', requestError);
  req.once('aborted', abort);
  res.once('close', abort);
  const header = (name: string) =>
    typeof req.headers[name] === 'string' ? (req.headers[name] as string) : '';
  try {
    // Start reading only once the consumer exists; native Git receives the original
    // content encoding and performs gzip decoding itself.
    const running = repositories.git.run(
      [
        '-c',
        'transfer.hideRefs=refs/merv/work/',
        '-c',
        'receive.fsckObjects=true',
        '-c',
        `receive.maxInputSize=${MAX_PUSH}`,
        '-c',
        'receive.advertiseAtomic=true',
        '-c',
        'http.getanyfile=false',
        '-c',
        'http.receivepack=true',
        '-c',
        `http.maxRequestBuffer=${MAX_FETCH}`,
        '-c',
        'core.fsync=all',
        ...(options.hooksPath ? ['-c', `core.hooksPath=${options.hooksPath}`] : []),
        'http-backend',
      ],
      {
        env: {
          PATH_TRANSLATED: `${repositories.paths(projectId).repository}/${route}`,
          REQUEST_METHOD: req.method!,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: header('content-type'),
          ...(header('content-length') ? { CONTENT_LENGTH: header('content-length') } : {}),
          HTTP_CONTENT_ENCODING: header('content-encoding'),
          HTTP_GIT_PROTOCOL: header('git-protocol'),
          REMOTE_USER: 'merv',
          REMOTE_ADDR: req.socket.remoteAddress ?? '',
          SERVER_PROTOCOL: `HTTP/${req.httpVersion}`,
          GIT_HTTP_EXPORT_ALL: '1',
          ...(options.socketPath ? { MERV_GIT_SOCKET: options.socketPath } : {}),
        },
        input,
        ...(output ? { outputStream: output } : {}),
        maxBuffer: MAX_REPLY,
        timeoutMs: 15 * 60_000,
        signal: controller.signal,
        ...(options.durableOwner ? { durableOwner: options.durableOwner } : {}),
      },
    );
    req.pipe(input);
    let result: GitResult;
    try {
      result = await running;
    } catch (error) {
      throw inputError ?? outputError ?? error;
    } finally {
      await options.beforeReply?.();
    }
    if (result.code !== 0) throw new MervError('code_git_failed', 'Git HTTP backend failed', 502);
    if (res.destroyed) throw stopped();
    if (output) {
      if (outputError) throw outputError;
      const complete = finished(output, { cleanup: true });
      output.end();
      await complete;
    } else {
      const found = headers(result.stdout);
      if (!found) throw failed();
      res.writeHead(found.status, found.values);
      res.write(found.body);
    }
    res.end();
  } finally {
    req.unpipe(input);
    req.removeListener('error', requestError);
    req.removeListener('aborted', abort);
    res.removeListener('close', abort);
    input.destroy();
    output?.destroy();
  }
}
