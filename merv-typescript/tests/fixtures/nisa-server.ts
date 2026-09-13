import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export interface NisaReply {
  /** Strings are sent verbatim, so tests can supply malformed JSON. Other values are JSON encoded. */
  body: unknown;
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
  redirect?: string;
  /** Flush headers and a partial body, then remain open until fixture shutdown. */
  stallBody?: boolean;
  /** Send real HTTP body chunks of this size, paced by chunkDelayMs (default 20ms). */
  chunkBytes?: number;
  chunkDelayMs?: number;
}
export interface NisaRequest {
  identityLabel: string;
  method: string;
  path: string;
  body: unknown;
}
export interface NisaFixtureOptions {
  /** Exact Authorization header values map to safe evidence labels. */
  identities?: Record<string, string>;
  search?: NisaReply;
  papers?: Record<string, NisaReply>;
}
export interface NisaBarrier {
  entered: Promise<void>;
  release(): void;
}
interface InternalBarrier extends NisaBarrier {
  enter(): void;
  wait: Promise<void>;
}
function barrier(): InternalBarrier {
  let enter!: () => void, release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}

export const representativeNisaPaper = {
  arxiv_id: '1706.03762',
  title: 'Attention Is All You Need',
  authors: 'A. Author',
  abstract: 'Synthetic fixture evidence for paper retrieval.',
  year: 2017,
  citation_count: 123,
  url: 'https://arxiv.org/abs/1706.03762',
  categories: 'cs.CL cs.LG',
  cluster: null,
  pagerank: null,
};
export const representativeNisaSearch = {
  query: 'attention',
  count: 1,
  offset: 0,
  limit: 10,
  truncated: false,
  index_latest_pub_month: 202609,
  papers: [
    {
      arxiv_id: representativeNisaPaper.arxiv_id,
      title: representativeNisaPaper.title,
      year: representativeNisaPaper.year,
      authors: representativeNisaPaper.authors,
      citation_count: representativeNisaPaper.citation_count,
      score: 4.2,
      snippets: ['Synthetic matched passage.'],
      url: representativeNisaPaper.url,
      source: 'search',
      why: 'Synthetic matched passage.',
    },
  ],
};

/** Independent REST fixture. Saved request evidence omits headers and redacts configured credentials. */
export class NisaServer {
  url!: string;
  readonly requests: NisaRequest[] = [];
  rejected = 0;
  #identities: Map<string, string>;
  #secrets: string[];
  #search: NisaReply;
  #papers: Map<string, NisaReply>;
  #http?: HttpServer;
  #sockets = new Set<Socket>();
  #barriers = new Set<InternalBarrier>();
  #queue: InternalBarrier[] = [];
  #closing = false;

  constructor(options: NisaFixtureOptions = {}) {
    this.#identities = new Map(Object.entries(options.identities ?? {}));
    this.#secrets = [...this.#identities.keys()]
      .flatMap((value) => [value, value.replace(/^Bearer /i, '')])
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    this.#search = structuredClone(options.search ?? { body: representativeNisaSearch });
    this.#papers = new Map(
      Object.entries(options.papers ?? { '1706.03762': { body: representativeNisaPaper } }).map(
        ([id, reply]) => [id, structuredClone(reply)],
      ),
    );
  }
  get requestCount(): number {
    return this.requests.length;
  }
  get activeSocketCount(): number {
    return this.#sockets.size;
  }
  setSearch(reply: NisaReply): void {
    this.#search = structuredClone(reply);
  }
  setPaper(id: string, reply: NisaReply): void {
    this.#papers.set(id, structuredClone(reply));
  }
  holdNextRequest(): NisaBarrier {
    const held = barrier();
    this.#queue.push(held);
    this.#barriers.add(held);
    return held;
  }
  async start(): Promise<string> {
    if (this.#http) throw new Error('Nisa fixture is already running');
    this.#closing = false;
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end('{"error":"Fixture request failed"}');
      });
    });
    server.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.#http = server;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return this.url;
  }
  async close(): Promise<void> {
    this.#closing = true;
    for (const held of this.#barriers) held.release();
    this.#barriers.clear();
    this.#queue.length = 0;
    const server = this.#http;
    this.#http = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      for (const socket of this.#sockets) socket.destroy();
      server.closeAllConnections();
    });
    this.#sockets.clear();
  }
  private scrub(value: unknown): unknown {
    if (typeof value === 'string') {
      let output = value;
      for (const secret of this.#secrets) output = output.split(secret).join('[redacted]');
      return output;
    }
    if (Array.isArray(value)) return value.map((child) => this.scrub(child));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [String(this.scrub(key)), this.scrub(child)]),
      );
    return value;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid');
    let body: unknown = null;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 1_000_000) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(bytes);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const identityLabel =
      typeof req.headers.authorization === 'string'
        ? this.#identities.get(req.headers.authorization)
        : undefined;
    this.requests.push({
      identityLabel: identityLabel ?? 'anonymous',
      method: req.method ?? '',
      path: String(this.scrub(url.pathname + url.search)),
      body: this.scrub(body),
    });
    const held = this.#queue.shift();
    if (held) {
      held.enter();
      await held.wait;
      this.#barriers.delete(held);
    }
    if (this.#closing || res.destroyed) return;
    let reply: NisaReply;
    if (req.method === 'POST' && url.pathname === '/api/sdk/search') {
      if (!identityLabel) {
        this.rejected++;
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Unauthorized"}');
        return;
      }
      reply = this.#search;
    } else if (req.method === 'GET' && url.pathname.startsWith('/api/sdk/paper/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/sdk/paper/'.length));
      reply = this.#papers.get(id) ?? { status: 404, body: { error: 'Paper not found' } };
    } else {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found"}');
      return;
    }
    res.writeHead(reply.status ?? (reply.redirect ? 302 : 200), {
      'content-type': reply.contentType ?? 'application/json',
      ...reply.headers,
      ...(reply.redirect ? { location: reply.redirect } : {}),
    });
    if (reply.stallBody) {
      res.flushHeaders();
      res.write('{');
      return;
    }
    const bodyText = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    if (reply.chunkBytes !== undefined) {
      const chunkDelayMs = reply.chunkDelayMs ?? 20;
      if (
        !Number.isSafeInteger(reply.chunkBytes) ||
        reply.chunkBytes < 1 ||
        !Number.isSafeInteger(chunkDelayMs) ||
        chunkDelayMs < 0
      )
        throw new Error('Invalid fixture chunk configuration');
      const bytes = Buffer.from(bodyText);
      for (let offset = 0; offset < bytes.length; offset += reply.chunkBytes) {
        if (this.#closing || res.destroyed) return;
        res.write(bytes.subarray(offset, offset + reply.chunkBytes));
        if (offset + reply.chunkBytes < bytes.length) await delay(chunkDelayMs);
      }
      if (!this.#closing && !res.destroyed) res.end();
    } else res.end(bodyText);
  }
}
