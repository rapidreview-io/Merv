import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { MervError, type Principal, type State, type Sql } from '@merv/contracts';
import type { ProjectScope } from './index.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const iso = (n: number) => new Date(n).toISOString();
const DAY = 86400000;
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
function requireOAuth(
  ok: unknown,
  error = 'invalid_request',
  message = 'Invalid OAuth request',
): asserts ok {
  if (!ok) throw new OAuthError(error, message);
}
export const oauthConfig = z
  .object({
    trustedProxyIps: z
      .array(z.string().refine((ip) => isIP(ip) !== 0))
      .max(32)
      .default(['127.0.0.1', '::1']),
    publicOrigin: z.string().refine((value) => {
      try {
        const u = new URL(value);
        return (
          u.origin === value &&
          (u.protocol === 'https:' ||
            (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
        );
      } catch {
        return false;
      }
    }, 'Expected an HTTPS origin (HTTP loopback for tests only)'),
  })
  .strict();
interface Client {
  id: string;
  name: string;
  redirects: string;
}
interface Pending {
  id: string;
  client_id: string;
  redirect_uri: string;
  challenge: string;
  state: string;
  resource: string;
  expires_at: string;
  code_hash: string | null;
  key_id: string | null;
  used: number;
}
interface Token {
  hash: string;
  grant_id: string;
  client_id: string;
  kind: string;
  expires_at: string;
  used: number;
  key_id: string;
  revoked: number;
}

/** Opaque tokens are hashed at rest. The underlying delegation retains Scope's live membership,
 * review independence and audit checks. Its machine secret is discarded, never sent to a client. */
export class OAuth {
  readonly resource: string;
  constructor(
    readonly state: State,
    readonly scope: ProjectScope,
    readonly origin: string,
    readonly clock = Date.now,
  ) {
    oauthConfig.parse({ publicOrigin: origin });
    this.resource = `${origin}/mcp`;
  }
  async initialize() {
    await this.state.migrate('mcp_oauth', {
      1: `CREATE TABLE oauth_clients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, redirects TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE oauth_requests (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oauth_clients(id), redirect_uri TEXT NOT NULL,
      challenge TEXT NOT NULL, state TEXT NOT NULL, resource TEXT NOT NULL, expires_at TEXT NOT NULL,
      code_hash TEXT UNIQUE, key_id TEXT REFERENCES user_keys(id), used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE oauth_grants (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oauth_clients(id), key_id TEXT NOT NULL REFERENCES user_keys(id),
      resource TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE oauth_tokens (
      hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id), kind TEXT NOT NULL,
      expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
    CREATE INDEX oauth_requests_expiry ON oauth_requests(expires_at);
    `,
    });
  }
  metadata() {
    return {
      issuer: this.origin,
      authorization_endpoint: `${this.origin}/oauth/authorize`,
      token_endpoint: `${this.origin}/oauth/token`,
      registration_endpoint: `${this.origin}/oauth/register`,
      revocation_endpoint: `${this.origin}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['merv'],
      authorization_response_iss_parameter_supported: true,
    };
  }
  protectedResource() {
    return {
      resource: this.resource,
      authorization_servers: [this.origin],
      scopes_supported: ['merv'],
      bearer_methods_supported: ['header'],
      resource_documentation: `${this.origin}/connect/agent.md`,
    };
  }
  async register(input: unknown) {
    const parsed = z
      .object({
        client_name: z.string().trim().min(1).max(100).default('MCP client'),
        redirect_uris: z.array(z.string().max(2048)).min(1).max(10),
        token_endpoint_auth_method: z.literal('none').default('none'),
        grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).optional(),
        response_types: z.array(z.literal('code')).optional(),
      })
      .safeParse(input);
    requireOAuth(parsed.success, 'invalid_client_metadata');
    const data = parsed.data;
    for (const uri of data.redirect_uris) {
      let u: URL;
      try {
        u = new URL(uri);
      } catch {
        throw new OAuthError('invalid_redirect_uri', 'Invalid callback');
      }
      requireOAuth(
        !u.username &&
          !u.password &&
          !u.hash &&
          (u.protocol === 'https:' ||
            (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))),
        'invalid_redirect_uri',
        'Callbacks require HTTPS or HTTP loopback',
      );
    }
    const id = secret();
    await this.state.transaction(async (tx) => {
      // Bound unauthenticated registration, also across restarts/instances. Deployments should
      // additionally rate limit /oauth/register at their ingress by source address.
      const recent = await tx.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM oauth_clients WHERE created_at>?',
        iso(this.clock() - DAY),
      );
      requireOAuth(
        Number(recent?.n) < 10000,
        'temporarily_unavailable',
        'Registration capacity reached',
      );
      await tx.run(
        'INSERT INTO oauth_clients(id,name,redirects,created_at) VALUES(?,?,?,?)',
        id,
        data.client_name,
        JSON.stringify(data.redirect_uris),
        iso(this.clock()),
      );
    });
    return {
      client_id: id,
      client_id_issued_at: Math.floor(this.clock() / 1000),
      ...data,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }
  private async client(sql: Sql, id: string) {
    const client = await sql.get<Client>('SELECT * FROM oauth_clients WHERE id=?', id);
    requireOAuth(client, 'invalid_client', 'Unknown OAuth client');
    return client;
  }
  async start(p: URLSearchParams) {
    requireOAuth([...p.keys()].every((k) => p.getAll(k).length === 1));
    const client = await this.state.read((sql) => this.client(sql, p.get('client_id') ?? ''));
    const redirect = p.get('redirect_uri') ?? '';
    requireOAuth(
      JSON.parse(client.redirects).includes(redirect),
      'invalid_request',
      'Unregistered callback',
    );
    requireOAuth(p.get('response_type') === 'code', 'unsupported_response_type');
    requireOAuth(
      p.get('code_challenge_method') === 'S256' &&
        /^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') ?? ''),
      'invalid_request',
      'PKCE S256 is required',
    );
    requireOAuth(p.get('resource') === this.resource, 'invalid_target', 'MCP resource is required');
    requireOAuth(!p.has('scope') || p.get('scope') === 'merv', 'invalid_scope');
    requireOAuth((p.get('state') ?? '').length <= 4096);
    const id = secret();
    await this.state.transaction(async (tx) => {
      await tx.run('DELETE FROM oauth_requests WHERE expires_at<?', iso(this.clock()));
      const count = await tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM oauth_requests');
      requireOAuth(Number(count?.n) < 10000, 'temporarily_unavailable');
      await tx.run(
        'INSERT INTO oauth_requests(id,client_id,redirect_uri,challenge,state,resource,expires_at) VALUES(?,?,?,?,?,?,?)',
        id,
        client.id,
        redirect,
        p.get('code_challenge')!,
        p.get('state') ?? '',
        this.resource,
        iso(this.clock() + 600000),
      );
    });
    return id;
  }
  private async pending(sql: Sql, id: string) {
    const p = await sql.get<Pending>('SELECT * FROM oauth_requests WHERE id=?', id);
    requireOAuth(
      p && p.resource === this.resource && p.expires_at > iso(this.clock()) && !p.used,
      'invalid_grant',
      'Authorization expired or already used',
    );
    return p;
  }
  async details(id: string) {
    return this.state.read(async (sql) => {
      const p = await this.pending(sql, id);
      const c = await this.client(sql, p.client_id);
      return { clientName: c.name, redirectUri: p.redirect_uri, resource: p.resource };
    });
  }
  async consent(id: string, principal: Principal, allow: boolean) {
    requireOAuth(principal.kind === 'user', 'access_denied', 'Sign in with a human account');
    return this.state.transaction(async (tx) => {
      const p = await this.pending(tx, id);
      requireOAuth(!p.code_hash, 'invalid_grant', 'Already authorized');
      const callback = new URL(p.redirect_uri);
      callback.searchParams.set('state', p.state);
      callback.searchParams.set('iss', this.origin);
      if (!allow) {
        await tx.run('UPDATE oauth_requests SET used=1 WHERE id=?', id);
        callback.searchParams.set('error', 'access_denied');
        return callback.href;
      }
      const issued = await this.scope.userKeys.createAccountDelegation(
        principal,
        {
          label: 'OAuth: ' + (await this.client(tx, p.client_id)).name,
          expiresAt: iso(this.clock() + 30 * DAY),
        },
        tx,
      );
      const code = secret();
      await tx.run(
        'UPDATE oauth_requests SET code_hash=?,key_id=?,expires_at=? WHERE id=?',
        hash(code),
        issued.key.id,
        iso(this.clock() + 60000),
        id,
      );
      callback.searchParams.set('code', code);
      return callback.href;
    });
  }
  private async token(sql: Sql, token: string): Promise<Token | undefined> {
    return sql.get<Token>(
      `SELECT t.*,g.client_id,g.key_id,g.revoked FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE t.hash=? AND g.expires_at>? AND g.resource=?`,
      hash(token),
      iso(this.clock()),
      this.resource,
    );
  }
  private async issue(tx: Sql, grant: string) {
    const access = 'mo_' + secret(),
      refresh = 'mrfr_' + secret();
    await tx.run(
      'INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES(?,?,?,?)',
      hash(access),
      grant,
      'access',
      iso(this.clock() + 3600000),
    );
    await tx.run(
      'INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES(?,?,?,?)',
      hash(refresh),
      grant,
      'refresh',
      iso(this.clock() + 30 * DAY),
    );
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refresh,
      scope: 'merv',
    };
  }
  private async requireDelegation(id: string) {
    try {
      await this.scope.userKeys.authenticateDelegation(id);
    } catch (error) {
      if (error instanceof MervError && (error.status === 401 || error.status === 403))
        throw new OAuthError('invalid_grant', 'Authorization expired or revoked');
      throw error;
    }
  }
  async exchange(p: URLSearchParams) {
    requireOAuth([...p.keys()].every((k) => p.getAll(k).length === 1));
    requireOAuth(p.get('resource') === this.resource, 'invalid_target', 'MCP resource is required');
    requireOAuth(!p.has('scope') || p.get('scope') === 'merv', 'invalid_scope');
    const result = await this.state.transaction(async (tx) => {
      const client = await this.client(tx, p.get('client_id') ?? '');
      if (p.get('grant_type') === 'authorization_code') {
        const row = await tx.get<Pending>(
          'SELECT * FROM oauth_requests WHERE code_hash=?',
          hash(p.get('code') ?? ''),
        );
        requireOAuth(
          row &&
            row.client_id === client.id &&
            row.resource === this.resource &&
            row.redirect_uri === p.get('redirect_uri') &&
            row.key_id,
          'invalid_grant',
        );
        const verifier = p.get('code_verifier') ?? '';
        requireOAuth(
          /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) &&
            createHash('sha256').update(verifier).digest('base64url') === row.challenge,
          'invalid_grant',
        );
        if (row.used) {
          await tx.run('UPDATE oauth_grants SET revoked=1 WHERE key_id=?', row.key_id);
          await this.scope.userKeys.revokeDelegation(row.key_id, tx);
          return null; // Commit genuine code-replay revocation before returning the error.
        }
        requireOAuth(row.expires_at > iso(this.clock()), 'invalid_grant');
        await this.requireDelegation(row.key_id);
        await tx.run('UPDATE oauth_requests SET used=1 WHERE id=?', row.id);
        const grant = secret();
        await tx.run(
          'INSERT INTO oauth_grants(id,client_id,key_id,resource,expires_at) VALUES(?,?,?,?,?)',
          grant,
          client.id,
          row.key_id,
          this.resource,
          iso(this.clock() + 30 * DAY),
        );
        return this.issue(tx, grant);
      }
      requireOAuth(p.get('grant_type') === 'refresh_token', 'unsupported_grant_type');
      const t = await this.token(tx, p.get('refresh_token') ?? '');
      requireOAuth(
        t &&
          t.client_id === client.id &&
          t.kind === 'refresh' &&
          !t.revoked &&
          t.expires_at > iso(this.clock()),
        'invalid_grant',
      );
      if (t.used) {
        await tx.run('UPDATE oauth_grants SET revoked=1 WHERE id=?', t.grant_id);
        await this.scope.userKeys.revokeDelegation(t.key_id, tx);
        return null; // Commit replay revocation before reporting invalid_grant.
      }
      await this.requireDelegation(t.key_id);
      await tx.run('UPDATE oauth_tokens SET used=1 WHERE hash=?', t.hash);
      return this.issue(tx, t.grant_id);
    });
    requireOAuth(result, 'invalid_grant', 'Authorization replay; sign in again');
    return result;
  }
  async authenticate(token: string): Promise<Principal> {
    const t = await this.state.read((sql) => this.token(sql, token));
    if (!t || t.kind !== 'access' || t.revoked || t.expires_at <= iso(this.clock()))
      throw new MervError('unauthorized', 'OAuth authorization expired or revoked', 401);
    try {
      return { kind: 'key', key: await this.scope.userKeys.authenticateDelegation(t.key_id) };
    } catch {
      throw new MervError('unauthorized', 'OAuth authorization expired or revoked', 401);
    }
  }
  async revoke(p: URLSearchParams) {
    requireOAuth([...p.keys()].every((k) => p.getAll(k).length === 1));
    await this.state.transaction(async (tx) => {
      await this.client(tx, p.get('client_id') ?? '');
      const t = await this.token(tx, p.get('token') ?? '');
      if (!t || t.client_id !== p.get('client_id')) return;
      await tx.run('UPDATE oauth_grants SET revoked=1 WHERE id=?', t.grant_id);
      await this.scope.userKeys.revokeDelegation(t.key_id, tx);
    });
  }
}
