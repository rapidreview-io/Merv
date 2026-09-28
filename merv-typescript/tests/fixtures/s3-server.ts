import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface S3Request {
  method: string;
  key: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  query: Record<string, string>;
}

const etag = (bytes: Buffer) => `"${createHash('md5').update(bytes).digest('hex')}"`;
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
/** What each presigned method must sign, and for how long it is valid. */
const PRESIGNED: Record<string, { headers: string[]; expires: number }> = {
  GET: { headers: ['host'], expires: 60 },
  PUT: {
    headers: ['content-length', 'host', 'if-none-match', 'x-amz-checksum-sha256'],
    expires: 3600,
  },
};
/**
 * Verify real SigV4 query signing, so a changed project, key, response header or signed request
 * header cannot be used. A signed header the request leaves out is signed as empty and fails.
 */
function signed(url: URL, method: string, headers: IncomingHttpHeaders) {
  const params = url.searchParams;
  const rule = PRESIGNED[method];
  const date = params.get('X-Amz-Date') ?? '';
  const scope = (params.get('X-Amz-Credential') ?? '').split('/');
  const expires = Number(params.get('X-Amz-Expires'));
  const timestamp = Date.parse(
    date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'),
  );
  if (
    params.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' ||
    scope[0] !== 'fixture-access-key' ||
    !rule ||
    params.get('X-Amz-SignedHeaders') !== rule.headers.join(';') ||
    !Number.isFinite(timestamp) ||
    expires !== rule.expires ||
    Date.now() > timestamp + expires * 1000 ||
    timestamp > Date.now() + 1000
  )
    return false;
  const query = [...params]
    .filter(([key]) => key !== 'X-Amz-Signature')
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([a, av], [b, bv]) => (a! < b! ? -1 : a! > b! ? 1 : av!.localeCompare(bv!)))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const canonical = [
    method,
    url.pathname,
    query,
    rule.headers.map((name) => `${name}:${String(headers[name] ?? '').trim()}\n`).join(''),
    rule.headers.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const signing = [
    'AWS4-HMAC-SHA256',
    date,
    scope.slice(1).join('/'),
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');
  let key = Buffer.from('AWS4fixture-secret-key');
  for (const value of scope.slice(1))
    key = Buffer.from(createHmac('sha256', key).update(value).digest());
  const expected = createHmac('sha256', key).update(signing).digest();
  const supplied = Buffer.from(params.get('X-Amz-Signature') ?? '', 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Local HTTP protocol fixture; requests still use the real AWS SDK and SigV4 signing. */
export async function s3Server() {
  const objects = new Map<string, Buffer>();
  /** The Content-Encoding each object was uploaded with: stored metadata, as S3 keeps it. */
  const encodings = new Map<string, string>();
  const requests: S3Request[] = [];
  let failure: number | undefined;
  let readOverride: { body: Buffer; chunked?: boolean; stall?: boolean } | undefined;
  let hold:
    { method: string; entered: () => void; wait: Promise<void>; release: () => void } | undefined;
  const releases = new Set<() => void>();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://127.0.0.1');
      const key = decodeURIComponent(url.pathname).replace(/^\/merv-artifacts\//, '');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method!,
        key,
        headers: req.headers,
        body,
        query: Object.fromEntries(url.searchParams),
      });
      const pending = hold?.method === req.method ? hold : undefined;
      if (pending) {
        hold = undefined;
        pending.entered();
        await pending.wait;
        releases.delete(pending.release);
      }
      if (res.destroyed) return;
      const error = (status: number, code: string) => {
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end(`<Error><Code>${code}</Code><Message>provider-private-detail</Message></Error>`);
      };
      const presigned = url.searchParams.has('X-Amz-Algorithm');
      if (presigned && !signed(url, req.method!, req.headers))
        return error(403, 'SignatureDoesNotMatch');
      if (failure) return error(failure, failure === 403 ? 'AccessDenied' : 'ServiceUnavailable');
      if (!url.pathname.startsWith('/merv-artifacts/')) return error(404, 'NoSuchBucket');
      if (req.method === 'PUT') {
        if (req.headers['if-none-match'] !== '*') return error(400, 'MissingCondition');
        // A signed upload names its body's SHA-256; Blobs' own writes send its MD5.
        const digest = presigned
          ? req.headers['x-amz-checksum-sha256'] ===
            createHash('sha256').update(body).digest('base64')
          : req.headers['content-md5'] === createHash('md5').update(body).digest('base64');
        if (!digest) return error(400, 'BadDigest');
        if (objects.has(key)) return error(412, 'PreconditionFailed');
        objects.set(key, body);
        if (req.headers['content-encoding'])
          encodings.set(key, String(req.headers['content-encoding']));
        res.writeHead(200, { etag: etag(body) });
        res.end();
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        const stored = objects.get(key);
        const content = req.method === 'HEAD' ? stored : (readOverride?.body ?? stored);
        if (!content) return error(404, 'NoSuchKey');
        if (req.headers['if-match'] && req.headers['if-match'] !== etag(content))
          return error(412, 'PreconditionFailed');
        res.writeHead(200, {
          'content-type':
            url.searchParams.get('response-content-type') ?? 'application/octet-stream',
          etag: etag(content),
          ...(url.searchParams.has('response-content-disposition')
            ? { 'content-disposition': url.searchParams.get('response-content-disposition')! }
            : {}),
          ...(url.searchParams.has('response-cache-control')
            ? { 'cache-control': url.searchParams.get('response-cache-control')! }
            : {}),
          ...(url.searchParams.has('response-content-encoding') || encodings.has(key)
            ? {
                'content-encoding':
                  url.searchParams.get('response-content-encoding') ?? encodings.get(key)!,
              }
            : {}),
          ...(req.method === 'GET' && readOverride?.chunked
            ? {}
            : { 'content-length': content.byteLength }),
        });
        if (req.method === 'HEAD') return res.end();
        if (readOverride?.stall) {
          res.flushHeaders();
          return;
        }
        if (readOverride?.chunked) {
          res.write(content.subarray(0, Math.min(256_000, content.byteLength)));
          res.end(content.subarray(Math.min(256_000, content.byteLength)));
        } else res.end(content);
      } else error(405, 'MethodNotAllowed');
    } catch {
      res.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    objects,
    requests,
    fail(status?: number) {
      failure = status;
    },
    overrideRead(value?: typeof readOverride) {
      readOverride = value;
    },
    holdNext(method: string) {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { method, entered, wait, release };
      releases.add(release);
      return { started, release };
    },
    async close() {
      for (const release of releases) release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
