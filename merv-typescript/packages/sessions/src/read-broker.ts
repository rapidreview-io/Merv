import { z } from 'zod';
import {
  canonical,
  MervError,
  newId,
  sha256Hex,
  type Caller,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import { CredentialStore } from '@merv/identity/credentials';

// Internal service only. No MCP tool or HTTP route registers this engine. In particular,
// callers cannot submit a policy, choose a role, or obtain a token through ordinary tools.
const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const role = z.enum(['source', 'destination']);
const peerSchema = z
  .object({ namespace: id, sandboxId: id, launchId: id, jobId: id, role })
  .strict();
const bindingSchema = peerSchema
  .extend({
    projectId: id,
    sessionId: id,
    assignmentId: id,
    revision: z.number().int().nonnegative(),
    manifestId: id,
  })
  .strict();
const accessSchema = z
  .object({
    reviews: z.array(z.object({ reviewId: id, sha256: hash }).strict()).max(128),
    artifacts: z
      .array(z.object({ artifactId: id, sha256: hash, content: z.boolean() }).strict())
      .max(128),
  })
  .strict();
export const readBrokerPolicySchema = z
  .object({
    projectId: id,
    assignmentId: id,
    revision: z.number().int().nonnegative(),
    source: accessSchema,
    destination: accessSchema,
  })
  .strict();
const requestSchema = z.discriminatedUnion('name', [
  z
    .object({ name: z.literal('review.get'), arguments: z.object({ reviewId: id }).strict() })
    .strict(),
  z
    .object({ name: z.literal('artifact.get'), arguments: z.object({ artifactId: id }).strict() })
    .strict(),
  z
    .object({
      name: z.literal('artifact.read'),
      arguments: z
        .object({
          artifactId: id,
          offset: z.number().int().nonnegative(),
          length: z.number().int().min(1).max(8192),
        })
        .strict(),
    })
    .strict(),
]);
export type ReadBrokerPeer = z.infer<typeof peerSchema>;
export type ReadBrokerBinding = z.infer<typeof bindingSchema>;
export type ReadBrokerPolicy = z.infer<typeof readBrokerPolicySchema>;
export interface ReadBrokerAuthority {
  caller: Caller;
  expiresAt: string;
  /** Current immutable session execution/lease AND actual runtime job binding. */
  fingerprint: string;
}
export interface ReadBrokerDependencies {
  /** Open-world registry check; never runs while this engine holds a SQL transaction. */
  runtime(binding: ReadBrokerBinding, phase: 'provision' | 'read'): Promise<void>;
  /** Must load an operator-approved, still-valid deployment manifest; never request data. */
  policy(manifestId: string, sql: Sql): Promise<ReadBrokerPolicy>;
  /** Must use Sessions controlled/valid checks plus the live runtime job binding. */
  authorize(binding: ReadBrokerBinding, sql: Transaction): Promise<ReadBrokerAuthority>;
  review(caller: Caller, reviewId: string): Promise<unknown>;
  artifact(
    caller: Caller,
    artifactId: string,
  ): Promise<{ id: string; projectId: string; bytes: Uint8Array }>;
}
const OWNER = 'session_read_broker';
const KIND = 'public_authority_read';
const MAX_POLICY_BYTES = 2 * 1024 * 1024;
const migration = `CREATE TABLE session_read_broker_grants (
 id TEXT PRIMARY KEY, binding_json TEXT NOT NULL, policy_hash TEXT NOT NULL, authority_fingerprint TEXT NOT NULL
);
CREATE FUNCTION session_read_broker_immutable() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN RAISE EXCEPTION 'Read broker grants are immutable'; END; $merv$;
CREATE TRIGGER session_read_broker_immutable BEFORE UPDATE OR DELETE ON session_read_broker_grants
FOR EACH ROW EXECUTE FUNCTION session_read_broker_immutable();`;
interface Grant {
  id: string;
  binding_json: string;
  policy_hash: string;
  authority_fingerprint: string;
}

function denied(): never {
  throw new MervError('read_broker_denied', 'Public authority read was refused', 403);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) denied();
  return result.data;
}
function access(policy: ReadBrokerPolicy, binding: ReadBrokerBinding) {
  if (
    policy.projectId !== binding.projectId ||
    policy.assignmentId !== binding.assignmentId ||
    policy.revision !== binding.revision
  )
    denied();
  const selected = policy[binding.role];
  if (
    new Set(selected.reviews.map((x) => x.reviewId)).size !== selected.reviews.length ||
    new Set(selected.artifacts.map((x) => x.artifactId)).size !== selected.artifacts.length
  )
    denied();
  return selected;
}
function peerOf(binding: ReadBrokerBinding): ReadBrokerPeer {
  const { namespace, sandboxId, launchId, jobId, role } = binding;
  return { namespace, sandboxId, launchId, jobId, role };
}

export class SessionReadBroker {
  private readonly credentials: CredentialStore;
  constructor(
    private readonly state: State,
    private readonly deps: ReadBrokerDependencies,
    private readonly clock: () => number = Date.now,
  ) {
    this.credentials = new CredentialStore(state, clock);
  }
  async initialize() {
    await this.credentials.initialize();
    await this.state.migrate('session-read-broker', [{ version: 1, sql: migration }]);
  }
  /** Trusted provisioner only; returns a secret once for the encrypted job-bound envelope. */
  async issue(input: ReadBrokerBinding, ttlSeconds: number) {
    try {
      const binding = parse(bindingSchema, input);
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) denied();
      await this.deps.runtime(binding, 'provision');
      return await this.state.transaction(async (tx) => {
        const policy = parse(
          readBrokerPolicySchema,
          await this.deps.policy(binding.manifestId, tx),
        );
        access(policy, binding);
        const authority = await this.deps.authorize(binding, tx);
        if (authority.caller.projectId !== binding.projectId || !authority.fingerprint) denied();
        const deadline = Math.min(
          this.clock() + ttlSeconds * 1000,
          Date.parse(authority.expiresAt),
        );
        if (!(deadline > this.clock())) denied();
        const expiresAt = new Date(deadline).toISOString();
        const grantId = newId('rbg');
        await tx.run(
          'INSERT INTO session_read_broker_grants VALUES(?,?,?,?)',
          grantId,
          canonical(binding),
          sha256Hex(canonical(policy)),
          authority.fingerprint,
        );
        const issued = await this.credentials.issue(
          {
            owner: OWNER,
            subject: grantId,
            kind: KIND,
            prefix: 'mbr_',
            expiresAt,
            hardDeadline: expiresAt,
          },
          tx,
        );
        return { token: issued.token, grantId, expiresAt };
      });
    } catch {
      denied();
    }
  }
  /** Internal revocation by grant identity, never possession of a parent/global bearer. */
  async revoke(grantId: string) {
    await this.state.transaction(async (tx) => {
      const rows = await tx.all<{ token_hash: string }>(
        'SELECT token_hash FROM identity_credentials WHERE owner=? AND subject=? AND kind=?',
        OWNER,
        grantId,
        KIND,
      );
      for (const row of rows) await this.credentials.revoke(row.token_hash, OWNER, tx);
    });
  }
  private async authorized(token: string, peer: ReadBrokerPeer) {
    return this.state.transaction(async (sql) => {
      const credential = await this.credentials.authenticate(token, KIND, sql);
      if (credential.owner !== OWNER) denied();
      const grant = await sql.get<Grant>(
        'SELECT * FROM session_read_broker_grants WHERE id=?',
        credential.subject,
      );
      if (!grant) denied();
      const binding = parse(bindingSchema, JSON.parse(grant.binding_json));
      if (canonical(peerOf(binding)) !== canonical(peer)) denied();
      const policy = parse(readBrokerPolicySchema, await this.deps.policy(binding.manifestId, sql));
      if (sha256Hex(canonical(policy)) !== grant.policy_hash) denied();
      const selected = access(policy, binding);
      const authority = await this.deps.authorize(binding, sql);
      if (
        authority.caller.projectId !== binding.projectId ||
        authority.fingerprint !== grant.authority_fingerprint ||
        !(Date.parse(authority.expiresAt) > this.clock())
      )
        denied();
      return { binding, selected, authority, grantId: grant.id };
    });
  }
  /** Internal HTTPS receiver binding lookup; never expose this as a tool or return it to the role. */
  async peer(token: string): Promise<ReadBrokerPeer> {
    try {
      if (this.state.ambient || this.state.readScope) denied();
      return await this.state.read(async (sql) => {
        const credential = await this.credentials.authenticate(token, KIND, sql);
        if (credential.owner !== OWNER) denied();
        const grant = await sql.get<Grant>(
          'SELECT * FROM session_read_broker_grants WHERE id=?',
          credential.subject,
        );
        if (!grant) denied();
        return peerOf(parse(bindingSchema, JSON.parse(grant.binding_json)));
      });
    } catch {
      denied();
    }
  }
  /** Private receiver enrollment barrier; no records returned and no authority widened. */
  async ready(token: string): Promise<void> {
    try {
      if (this.state.ambient || this.state.readScope) denied();
      const peer = await this.peer(token);
      const before = await this.authorized(token, peer);
      await this.deps.runtime(before.binding, 'read');
      await this.authorized(token, peer);
    } catch {
      denied();
    }
  }
  /** peer MUST come from authenticated runtime transport, not JSON arguments or headers. */
  async call(token: string, trustedPeer: ReadBrokerPeer, input: unknown) {
    try {
      if (this.state.ambient || this.state.readScope) denied();
      const request = parse(requestSchema, input),
        peer = parse(peerSchema, trustedPeer);
      const before = await this.authorized(token, peer);
      await this.deps.runtime(before.binding, 'read');
      let value: unknown;
      if (request.name === 'review.get') {
        const pin = before.selected.reviews.find((x) => x.reviewId === request.arguments.reviewId);
        if (!pin) denied();
        const record = await this.deps.review(before.authority.caller, pin.reviewId);
        const encoded = canonical(record);
        if (Buffer.byteLength(encoded) > 128 * 1024 || sha256Hex(encoded) !== pin.sha256) denied();
        value = JSON.parse(encoded);
      } else {
        const pin = before.selected.artifacts.find(
          (x) => x.artifactId === request.arguments.artifactId,
        );
        if (!pin || (request.name === 'artifact.read' && !pin.content)) denied();
        const artifact = await this.deps.artifact(before.authority.caller, pin.artifactId);
        if (
          artifact.id !== pin.artifactId ||
          artifact.projectId !== before.binding.projectId ||
          artifact.bytes.byteLength > MAX_POLICY_BYTES ||
          sha256Hex(artifact.bytes) !== pin.sha256
        )
          denied();
        const metadata = {
          id: artifact.id,
          projectId: artifact.projectId,
          hash: pin.sha256,
          size: artifact.bytes.byteLength,
        };
        if (request.name === 'artifact.get') value = metadata;
        else {
          const content = new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes);
          const { offset, length } = request.arguments;
          if (
            offset > content.length ||
            (offset > 0 &&
              /[\uDC00-\uDFFF]/.test(content[offset] ?? '') &&
              /[\uD800-\uDBFF]/.test(content[offset - 1]!))
          )
            denied();
          let end = Math.min(content.length, offset + length);
          if (
            end < content.length &&
            /[\uD800-\uDBFF]/.test(content[end - 1] ?? '') &&
            /[\uDC00-\uDFFF]/.test(content[end]!)
          )
            end--;
          if (end === offset && offset < content.length) denied();
          value = {
            artifact: metadata,
            encoding: 'utf8',
            offset,
            total: content.length,
            content: content.slice(offset, end),
          };
        }
      }
      // An open-world read may cross a revocation, session close, or replacement job.
      await this.deps.runtime(before.binding, 'read');
      const after = await this.authorized(token, peer);
      if (after.grantId !== before.grantId) denied();
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
    } catch {
      denied();
    }
  }
}
