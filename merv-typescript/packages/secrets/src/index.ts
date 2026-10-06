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
  type HumanPrincipal,
  type State,
} from '@merv/contracts';
import type { AccountIdentity, HuggingFaceStatus, HuggingFaceGrant, Secrets } from './types.js';

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
];

/** A canonical base64url encoding of 32 random bytes, supplied only through deployment env. */
function encryptionKey(value: string | undefined): Uint8Array | undefined {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value ? bytes : undefined;
}
const binding = ({ issuer, subject }: AccountIdentity) => digest(['huggingface', issuer, subject]);
const unavailable = () =>
  new MervError('secrets_unavailable', 'Hugging Face token storage is unavailable', 503);
export const huggingFaceToken = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);

/** One account credential. State receives only authenticated ciphertext, never the token. */
export class AccountSecrets implements Secrets {
  readonly #key: Uint8Array | undefined;
  readonly #grantKey: Uint8Array | undefined;
  #authorize?: (grant: HuggingFaceGrant) => Promise<AccountIdentity | null>;
  constructor(
    private readonly state: State,
    key: string | undefined,
    private readonly clock = Date.now,
    readonly huggingFaceEndpoint: string | null = null,
  ) {
    this.#key = encryptionKey(key);
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
      const { plaintext, protectedHeader } = await compactDecrypt(token, this.#grantKey, {
        keyManagementAlgorithms: ['dir'],
        contentEncryptionAlgorithms: ['A256GCM'],
      });
      if (protectedHeader.typ !== 'merv-hf-grant') return null;
      const grant = grantSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
      if (grant.exp * 1000 <= this.clock()) return null;
      const identity = await this.#authorize(grant);
      return identity ? await this.resolveHuggingFaceToken(identity) : null;
    } catch {
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
    const ciphertext = await new CompactEncrypt(new TextEncoder().encode(token))
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid: binding(identity) })
      .encrypt(this.#key);
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
    try {
      const { plaintext, protectedHeader } = await compactDecrypt(row.ciphertext, this.#key, {
        keyManagementAlgorithms: ['dir'],
        contentEncryptionAlgorithms: ['A256GCM'],
      });
      if (protectedHeader.kid !== binding(identity)) throw unavailable();
      return new TextDecoder().decode(plaintext);
    } catch {
      throw unavailable();
    }
  }
}
const Config = z
  .object({
    encryptionKeyEnv: envName.default('MERV_SECRETS_ENCRYPTION_KEY'),
    huggingFaceEndpoint: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          !url.port &&
          /^[a-z0-9.-]+$/.test(url.hostname) &&
          value === `https://${url.hostname}/hf` &&
          url.pathname === '/hf' &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password
        );
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
