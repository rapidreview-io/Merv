import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ReadBrokerRuntime } from './read-broker-runtime.js';

export const READ_BROKER_PATH = '/internal/public-authority/read';
/** Explicit opt-in server composition only. Never mounted by the default API or tools. */
export function readBrokerHttp(runtime: Pick<ReadBrokerRuntime, 'read' | 'ready'>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    try {
      if (
        req.method !== 'POST' ||
        ![READ_BROKER_PATH, READ_BROKER_PATH + '/ready'].includes(req.url ?? '') ||
        req.headers['content-type'] !== 'application/json' ||
        req.headers['content-encoding'] ||
        req.headers['transfer-encoding']
      )
        throw Error();
      const authorization = req.headers.authorization;
      if (!authorization || !/^Bearer mbr_[A-Za-z0-9_-]{43}$/.test(authorization)) throw Error();
      const length = Number(req.headers['content-length']);
      if (!Number.isSafeInteger(length) || length < 1 || length > 16384) throw Error();
      req.setTimeout(10_000, () => req.destroy());
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > length) throw Error();
        chunks.push(Buffer.from(chunk));
      }
      if (size !== length) throw Error();
      // This dispatch deliberately runs outside ToolRegistry's read snapshot.
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const enrollment = req.url === READ_BROKER_PATH + '/ready';
      if (
        enrollment &&
        (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length)
      )
        throw Error();
      const result = enrollment
        ? await runtime.ready(authorization.slice(7))
        : await runtime.read(authorization.slice(7), input);
      res.writeHead(200).end(JSON.stringify(result));
    } catch {
      res.writeHead(403).end(
        JSON.stringify({
          isError: true,
          content: [{ type: 'text', text: 'Public authority read was refused' }],
        }),
      );
    }
  };
}
