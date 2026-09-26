/**
 * Fake search providers for @merv/web: a loopback HTTP server that records every request and
 * answers as the test says, and environment variables holding keys for one test.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';

export interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}
export interface Reply {
  status?: number;
  body?: unknown;
  /** Sent as it is, instead of `body` as JSON. */
  raw?: string;
  headers?: Record<string, string>;
}

export async function provider(
  t: TestContext,
  answer: (seen: Seen) => Reply | Promise<Reply> = () => ({ body: {} }),
) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    const entry = {
      method: req.method!,
      path: req.url!,
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    seen.push(entry);
    const reply = await answer(entry);
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
    res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** A fresh environment variable holding `value` for this test; its name is returned. */
export function keyEnv(t: TestContext, value: string): string {
  const name = `MERV_WEB_TEST_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  process.env[name] = value;
  t.after(() => {
    delete process.env[name];
  });
  return name;
}

/** Tavily's search answer: `count` results of `chars` characters each. */
export const tavilyResults = (count: number, chars = 100) => ({
  query: 'as asked',
  response_time: 0.4,
  results: Array.from({ length: count }, (_, index) => ({
    title: `Result ${index}`,
    url: `https://example.com/${index}`,
    content: String(index % 10).repeat(chars),
    score: 0.9 - index / 100,
  })),
});
