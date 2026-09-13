import { createServer, request, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Diagnostic metadata only; the protocol version is the only recorded header value. */
export interface ProtocolObservation {
  httpMethod?: string;
  method?: string;
  headerNames: string[];
  protocolHeader?: string;
  envelopeVersion?: string;
  initializeVersion?: string;
  clientInfo?: { name?: string; version?: string };
  status?: number;
  negotiatedVersion?: string;
}

const captureLimit = 64 * 1024;
const short = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.slice(0, 128) : undefined;

function parseMessages(body: string): Record<string, any>[] {
  try {
    const value = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [];
  } catch {
    return body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .flatMap((line) => parseMessages(line.slice(6)));
  }
}

/** Loopback-only observation proxy for a real agent test; close after the agent has finished. */
export async function startProtocolProxy(targetBaseUrl: string) {
  const target = new URL(targetBaseUrl);
  if (
    target.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname) ||
    target.username ||
    target.password ||
    target.pathname !== '/' ||
    target.search ||
    target.hash
  ) {
    throw new Error('Protocol observation requires an HTTP loopback origin');
  }
  const observations: ProtocolObservation[] = [];
  const upstreams = new Set<ClientRequest>();
  const server = createServer((incoming, outgoing) => {
    const observation: ProtocolObservation = {
      httpMethod: incoming.method,
      headerNames: Object.keys(incoming.headers).sort(),
      protocolHeader: short(incoming.headers['mcp-protocol-version']),
    };
    const isMcp = incoming.url?.split('?')[0] === '/mcp';
    if (isMcp) observations.push(observation);
    let requestSize = 0;
    const requestChunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => {
      requestSize += chunk.length;
      if (isMcp && requestSize <= captureLimit) requestChunks.push(chunk);
    });
    incoming.on('end', () => {
      if (!isMcp || requestSize > captureLimit) return;
      const [message] = parseMessages(Buffer.concat(requestChunks).toString('utf8'));
      if (!message) return;
      observation.method = short(message.method);
      observation.initializeVersion = short(message.params?.protocolVersion);
      observation.envelopeVersion = short(
        message.params?._meta?.['io.modelcontextprotocol/protocolVersion'],
      );
      const clientInfo =
        message.params?.clientInfo ?? message.params?._meta?.['io.modelcontextprotocol/clientInfo'];
      if (clientInfo && typeof clientInfo === 'object') {
        observation.clientInfo = {
          name: short(clientInfo.name),
          version: short(clientInfo.version),
        };
      }
    });
    // The destination is always the validated origin; a request path cannot change it.
    const upstream = request(
      target,
      {
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, host: target.host },
      },
      (response) => {
        observation.status = response.statusCode;
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        let responseSize = 0;
        const responseChunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          responseSize += chunk.length;
          if (observation.method === 'initialize' && responseSize <= captureLimit)
            responseChunks.push(chunk);
        });
        response.on('end', () => {
          if (observation.method !== 'initialize' || responseSize > captureLimit) return;
          for (const message of parseMessages(Buffer.concat(responseChunks).toString('utf8'))) {
            const version = short(message.result?.protocolVersion);
            if (version) observation.negotiatedVersion = version;
          }
        });
        response.on('error', () => outgoing.destroy());
        response.pipe(outgoing);
      },
    );
    upstreams.add(upstream);
    upstream.once('close', () => upstreams.delete(upstream));
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' });
      outgoing.end('Protocol observation upstream unavailable');
    });
    incoming.on('aborted', () => upstream.destroy());
    incoming.on('error', () => upstream.destroy());
    outgoing.on('error', () => upstream.destroy());
    outgoing.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    observations,
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
        for (const upstream of upstreams) upstream.destroy();
      })),
  };
}
