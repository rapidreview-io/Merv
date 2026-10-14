import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { MountHandler, UpgradeHandler } from '@merv/api/types';
import { MervError } from '@merv/contracts';

function pathOf(req: IncomingMessage): string {
  const path = req.url ?? '';
  if (!/^\/sbx\/(ui|v1)\//.test(path) || /[\\\s#]/.test(path))
    throw new MervError('not_found', 'Unknown endpoint', 404);
  const target = path.slice(4);
  const parsed = new URL(target, 'http://localhost');
  if (parsed.pathname !== target.split('?')[0] || /%(?:2e|2f|5c)/i.test(parsed.pathname))
    throw new MervError('not_found', 'Unknown endpoint', 404);
  return target;
}

function headersOf(headers: IncomingHttpHeaders, upgrade = false): IncomingHttpHeaders {
  const connection = String(headers.connection ?? '')
    .toLowerCase()
    .split(',')
    .map((part) => part.trim());
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      if (upgrade && ['connection', 'upgrade'].includes(name)) return true;
      return (
        !connection.includes(name) &&
        ![
          'host',
          'connection',
          'upgrade',
          'keep-alive',
          'transfer-encoding',
          'te',
          'trailer',
          'proxy-authorization',
          'proxy-authenticate',
          'forwarded',
          'x-real-ip',
        ].includes(name) &&
        (name === 'x-forwarded-for' || !name.startsWith('x-forwarded-'))
      );
    }),
  );
}

export function sandboxesProxy(origin: string): { handler: MountHandler; upgrade: UpgradeHandler } {
  const target = new URL(origin);
  return {
    handler(req, res) {
      const upstream = httpRequest(target, {
        method: req.method,
        path: pathOf(req),
        headers: headersOf(req.headers),
      });
      upstream.on('response', (response) => {
        res.writeHead(response.statusCode ?? 502, headersOf(response.headers));
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    },
    upgrade(req, socket, head) {
      if (req.headers.upgrade?.toLowerCase() !== 'websocket')
        throw new MervError('not_found', 'Unknown endpoint', 404);
      const upstream = httpRequest(target, {
        method: req.method,
        path: pathOf(req),
        headers: headersOf(req.headers, true),
      });
      upstream.on('upgrade', (response, remote, remoteHead) => {
        const headers = headersOf(response.headers, true);
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers)
            .flatMap(([key, value]) =>
              (Array.isArray(value) ? value : [value]).map((part) => `${key}: ${part}\r\n`),
            )
            .join('')}\r\n`,
        );
        if (head.length) remote.write(head);
        if (remoteHead.length) socket.write(remoteHead);
        remote.on('error', () => socket.destroy());
        remote.on('close', () => socket.destroy());
        socket.once('close', () => remote.destroy());
        socket.pipe(remote).pipe(socket);
      });
      upstream.on('response', (response) => {
        response.resume();
        socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\n\r\n`);
      });
      upstream.on('error', () => socket.destroy());
      socket.once('close', () => upstream.destroy());
      upstream.end();
    },
  };
}
