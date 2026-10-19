import type { Context } from 'cordis';
import { hkdfSync } from 'node:crypto';
import { CompactEncrypt, compactDecrypt } from 'jose';
import { z } from 'zod';
import {
  check,
  createService,
  digest,
  envName,
  MervError,
  stateFault,
  type HumanPrincipal,
  type State,
} from '@merv/contracts';
import type {
  AccountIdentity,
  HuggingFaceStatus,
  HuggingFaceGrant,
  PlatformSecretRecord,
  Secrets,
} from './types.js';

const grantSchema = z
  .object({ binding: z.string().min(1).max(2048), exp: z.number().int().safe().positive() })
  .strict();

const migrations = [
  {
    version: 1,
    sql: `CREATE TABLE account_huggingface_secrets (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (issuer, subject)
  );`,
  },
  {
    version: 2,
    sql: `CREATE TABLE platform_secrets (
    env TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_issuer TEXT NOT NULL,
    updated_subject TEXT NOT NULL
  );`,
  },
];

/** A canonical base64url encoding of 32 random bytes, supplied only through deployment env. */
function encryptionKey(value: string | undefined): Uint8Array | undefined {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value ? bytes : undefined;
}
const binding = ({ issuer, subject }: AccountIdentity) => digest(['huggingface', issuer, subject]);
const unavailable = (what = 'Hugging Face token storage') =>
  new MervError('secrets_unavailable', `${what} is unavailable`, 503);
/** Direct A256GCM encryption: how both a stored token and a grant are sealed. */
const DIR = { keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] };
/** A stored value, its authenticated `kid` binding it to one owner: an account, an env name. */
const seal = (key: Uint8Array, value: string, kid: string) =>
  new CompactEncrypt(new TextEncoder().encode(value))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid })
    .encrypt(key);
/** What `seal` sealed for `kid`; null for another owner's, another key's or altered text. */
async function open(key: Uint8Array, ciphertext: string, kid: string): Promise<string | null> {
  try {
    const { plaintext, protectedHeader } = await compactDecrypt(ciphertext, key, DIR);
    return protectedHeader.kid === kid ? new TextDecoder().decode(plaintext) : null;
  } catch {
    return null;
  }
}
const platformBinding = (env: string) => digest(['platform-secret', env]);
/** An env value: process.env holds no NUL, and 64 KiB holds any key file a provider issues. */
const platformValue = z
  .string()
  .min(1)
  .max(65_536)
  .refine((value) => !value.includes('\0'));
export const huggingFaceToken = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);

/** One account credential. State receives only authenticated ciphertext, never the token. */
export class AccountSecrets implements Secrets {
  readonly #key: Uint8Array | undefined;
  readonly #grantKey: Uint8Array | undefined;
  /** Whether platform secrets can be stored and opened: the deployment gave a valid key. */
  readonly platformAvailable: boolean;
  #authorize?: (grant: HuggingFaceGrant) => Promise<AccountIdentity | null>;
  constructor(
    private readonly state: State,
    key: string | undefined,
    private readonly clock = Date.now,
    readonly huggingFaceEndpoint: string | null = null,
  ) {
    this.#key = encryptionKey(key);
    this.platformAvailable = !!this.#key;
    if (this.#key)
      this.#grantKey = new Uint8Array(
        hkdfSync('sha256', this.#key, Buffer.alloc(0), 'merv/hf-grant/v1', 32),
      );
  }
  registerHuggingFaceAuthority(
    authorize: (grant: HuggingFaceGrant) => Promise<AccountIdentity | null>,
  ) {
    check(!this.#authorize, 'duplicate_authority', 'Hugging Face authority already registered');
    this.#authorize = authorize;
    return () => {
      if (this.#authorize === authorize) this.#authorize = undefined;
    };
  }
  async createHuggingFaceAccess(input: HuggingFaceGrant) {
    const grant = grantSchema.parse(input);
    if (
      !this.#grantKey ||
      !this.huggingFaceEndpoint ||
      !this.#authorize ||
      grant.exp * 1000 <= this.clock()
    )
      return null;
    const identity = await this.#authorize(grant);
    if (!identity || !(await this.resolveHuggingFaceToken(identity))) return null;
    const token = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify(grant)))
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: 'merv-hf-grant' })
      .encrypt(this.#grantKey);
    return { token, endpoint: this.huggingFaceEndpoint };
  }
  async resolveHuggingFaceGrant(token: string): Promise<string | null> {
    if (!this.#grantKey || !this.#authorize || token.length > 4096) return null;
    try {
      const { plaintext, protectedHeader } = await compactDecrypt(token, this.#grantKey, DIR);
      if (protectedHeader.typ !== 'merv-hf-grant') return null;
      const grant = grantSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
      if (grant.exp * 1000 <= this.clock()) return null;
      const identity = await this.#authorize(grant);
      return identity ? await this.resolveHuggingFaceToken(identity) : null;
    } catch (error) {
      // A refusal is no grant (401); an outage judged nothing, and a client retries its 503.
      if (stateFault(error)) throw error;
      return null;
    }
  }
  async initialize() {
    await this.state.migrate('secrets', migrations);
  }
  private identity(principal: HumanPrincipal): AccountIdentity {
    check(
      principal?.kind === 'user' &&
        principal.user &&
        typeof principal.user.issuer === 'string' &&
        !!principal.user.issuer &&
        typeof principal.user.subject === 'string' &&
        !!principal.user.subject &&
        Date.parse(principal.expiresAt) > this.clock(),
      'forbidden',
      'Sign in with an account to manage Hugging Face access',
      403,
    );
    return { issuer: principal.user.issuer, subject: principal.user.subject };
  }
  private async status(identity: AccountIdentity): Promise<HuggingFaceStatus> {
    const row = await this.state.read((sql) =>
      sql.get<{ updated_at: string }>(
        'SELECT updated_at FROM account_huggingface_secrets WHERE issuer=? AND subject=?',
        identity.issuer,
        identity.subject,
      ),
    );
    return { available: !!this.#key, configured: !!row, updatedAt: row?.updated_at ?? null };
  }
  async huggingFaceStatus(principal: HumanPrincipal) {
    return this.status(this.identity(principal));
  }
  async saveHuggingFace(principal: HumanPrincipal, token: string) {
    const identity = this.identity(principal);
    if (!this.#key) throw unavailable();
    // Validation failures contain no submitted value or library exception.
    check(
      huggingFaceToken.safeParse(token).success,
      'invalid_input',
      'Enter a valid Hugging Face token',
    );
    const ciphertext = await seal(this.#key, token, binding(identity));
    await this.state.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO account_huggingface_secrets(issuer,subject,ciphertext,updated_at) VALUES (?,?,?,?)
       ON CONFLICT (issuer,subject) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,updated_at=EXCLUDED.updated_at`,
        identity.issuer,
        identity.subject,
        ciphertext,
        new Date(this.clock()).toISOString(),
      );
    });
    return this.status(identity);
  }
  async removeHuggingFace(principal: HumanPrincipal) {
    const identity = this.identity(principal);
    await this.state.transaction(async (tx) => {
      await tx.run(
        'DELETE FROM account_huggingface_secrets WHERE issuer=? AND subject=?',
        identity.issuer,
        identity.subject,
      );
    });
    return this.status(identity);
  }
  /** Private runtime delivery only. The caller must authorize the immutable delegation owner. */
  async resolveHuggingFaceToken(identity: AccountIdentity): Promise<string | null> {
    // Missing deployment configuration must not prevent workers without credentials starting.
    if (!this.#key) return null;
    identity = { issuer: identity.issuer, subject: identity.subject };
    const row = await this.state.read((sql) =>
      sql.get<{ ciphertext: string }>(
        'SELECT ciphertext FROM account_huggingface_secrets WHERE issuer=? AND subject=?',
        identity.issuer,
        identity.subject,
      ),
    );
    if (!row) return null;
    const token = await open(this.#key, row.ciphertext, binding(identity));
    if (token === null) throw unavailable();
    return token;
  }
  /** Platform secrets an admin stored, which replace the env values of the same names: names
   *  and times only. */
  async platformSecrets(): Promise<PlatformSecretRecord[]> {
    return await this.state.read((sql) =>
      sql.all<PlatformSecretRecord>(
        'SELECT env,updated_at AS "updatedAt" FROM platform_secrets ORDER BY env',
      ),
    );
  }
  /** The stored value of `env`, decrypted; null with none stored, or without the key. */
  async platformSecret(env: string): Promise<string | null> {
    if (!this.#key) return null;
    const row = await this.state.read((sql) =>
      sql.get<{ ciphertext: string }>('SELECT ciphertext FROM platform_secrets WHERE env=?', env),
    );
    if (!row) return null;
    const value = await open(this.#key, row.ciphertext, platformBinding(env));
    if (value === null) throw unavailable('Stored platform secrets');
    return value;
  }
  /** Stores `value` for `env`, sealed to that name. The caller authorizes `by`. */
  async setPlatformSecret(env: string, value: string, by: AccountIdentity) {
    if (!this.#key) throw unavailable('Stored platform secrets');
    // The refusals carry no submitted value.
    check(envName.safeParse(env).success, 'invalid_input', 'Name an environment variable');
    check(platformValue.safeParse(value).success, 'invalid_input', 'Enter a secret value');
    const ciphertext = await seal(this.#key, value, platformBinding(env));
    await this.state.transaction((tx) =>
      tx.run(
        `INSERT INTO platform_secrets(env,ciphertext,updated_at,updated_issuer,updated_subject)
         VALUES (?,?,?,?,?) ON CONFLICT (env) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,
         updated_at=EXCLUDED.updated_at,updated_issuer=EXCLUDED.updated_issuer,
         updated_subject=EXCLUDED.updated_subject`,
        env,
        ciphertext,
        new Date(this.clock()).toISOString(),
        by.issuer,
        by.subject,
      ),
    );
  }
}
const Config = z
  .object({
    encryptionKeyEnv: envName
      .describe('Stored secrets · encryption key')
      .default('MERV_SECRETS_ENCRYPTION_KEY'),
    huggingFaceEndpoint: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return /^[a-z0-9.-]+$/.test(url.hostname) && value === `https://${url.hostname}/hf`;
      })
      .optional(),
  })
  .strict()
  .default({});
export const secretsPlugin = {
  name: 'merv-secrets',
  Config,
  inject: ['state'],
  async apply(ctx: Context, config: z.infer<typeof Config>) {
    ctx.provide(
      'secrets',
      await createService(
        new AccountSecrets(
          ctx.state,
          process.env[config.encryptionKeyEnv],
          Date.now,
          config.huggingFaceEndpoint,
        ),
      ),
    );
  },
};
export default secretsPlugin;
