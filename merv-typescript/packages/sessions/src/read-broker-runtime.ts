import {
  canonical,
  MervError,
  newId,
  requireAdministrator,
  sha256Hex,
  type Artifacts,
  type Caller,
  type Reviews,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { SbxMerv } from '@sandboxes/merv-host';
import { launchIds } from '@sandboxes/runtimes';
import type { LeasedSessions } from './index.js';
import type { SessionControl } from './types.js';
import {
  SessionReadBroker,
  readBrokerPolicySchema,
  type ReadBrokerBinding,
  type ReadBrokerPolicy,
} from './read-broker.js';
import { provisionReadBroker, type ReadBrokerDeployment } from './read-broker-provision.js';

interface Approved {
  id: string;
  owner: Caller;
  control: SessionControl & { hostRef: string };
  deployment: ReadBrokerDeployment;
  policy: ReadBrokerPolicy;
  reviewId: string;
  reviewHash: string;
  nativeId: string;
}
interface Row {
  data_json: string;
  state: string;
  grant_id: string | null;
}
const migration = `
CREATE TABLE session_read_broker_deployments (
 id TEXT PRIMARY KEY, data_json TEXT NOT NULL, sandbox_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('approved','claimed','launched','failed','revoked')),
 grant_id TEXT, receipt_json TEXT, revocation_uncertain BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE FUNCTION session_read_broker_deployment_immutable() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
 IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.data_json<>OLD.data_json OR NEW.sandbox_id<>OLD.sandbox_id
 THEN RAISE EXCEPTION 'Read broker deployment identity is immutable'; END IF;
 RETURN NEW;
END; $merv$;
CREATE TRIGGER session_read_broker_deployment_immutable BEFORE UPDATE OR DELETE ON session_read_broker_deployments
FOR EACH ROW EXECUTE FUNCTION session_read_broker_deployment_immutable();`;
const refused = () => new MervError('read_broker_denied', 'Public authority read was refused', 403);

/** Server composition only. Nothing registers this service, approval, or its HTTP receiver. */
export class ReadBrokerRuntime {
  readonly broker: SessionReadBroker;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly sessions: Pick<LeasedSessions, 'readBrokerAuthority'>,
    private readonly reviews: Reviews,
    private readonly artifacts: Artifacts,
    private readonly sandboxes: SbxMerv,
    private readonly clock: () => number = Date.now,
  ) {
    this.broker = new SessionReadBroker(
      state,
      {
        policy: async (id, sql) => {
          const row = await sql.get<Row>(
            'SELECT * FROM session_read_broker_deployments WHERE id=?',
            id,
          );
          if (!row || !['claimed', 'launched'].includes(row.state)) throw refused();
          return (JSON.parse(row.data_json) as Approved).policy;
        },
        authorize: async (binding, tx) => {
          const approved = await this.approved(binding.manifestId, tx);
          if (canonical(this.binding(approved)) !== canonical(binding)) throw refused();
          // Recheck the approving member and the current parent lease independently.
          requireAdministrator(
            await scope.require(approved.owner, 'admin', tx),
            'read_broker_denied',
            'Public authority read was refused',
          );
          const review = await reviews.get(approved.owner, approved.reviewId, tx);
          if (
            sha256Hex(canonical(review)) !== approved.reviewHash ||
            review.status !== 'submitted' ||
            review.verdict !== 'pass'
          )
            throw refused();
          return sessions.readBrokerAuthority(approved.owner, approved.control, binding, tx);
        },
        runtime: async (binding, phase) => {
          const approved = await state.read((sql) => this.approved(binding.manifestId, sql));
          if (canonical(this.binding(approved)) !== canonical(binding)) throw refused();
          const { sandbox, launch } = await sandboxes
            .runtimes(approved.owner)
            .inspect(binding.sandboxId, phase === 'read' ? binding.launchId : undefined);
          if (
            sandbox.namespace !== binding.namespace ||
            sandbox.native_id !== approved.nativeId ||
            sandbox.provider !== 'modal' ||
            sandbox.state !== 'ready' ||
            sandbox.stopped_at ||
            !sandbox.lease_expires_at ||
            sandbox.lease_expires_at.toDate().getTime() <= this.clock()
          )
            throw refused();
          if (
            phase === 'read' &&
            (!launch ||
              launch.job_id !== binding.jobId ||
              launch.release_id !== approved.deployment.releaseId ||
              launch.delivery_state !== 'launched' ||
              !['pending', 'consumed'].includes(launch.state))
          )
            throw refused();
        },
        review: (caller, id) => reviews.get(caller, id),
        artifact: async (caller, id) => {
          const { artifact, bytes } = await artifacts.bytes(caller, id);
          return { id: artifact.id, projectId: artifact.projectId, bytes };
        },
      },
      clock,
    );
  }
  async initialize() {
    await this.state.migrate('session-read-broker-deployments', [{ version: 1, sql: migration }]);
    await this.broker.initialize();
  }
  private async approved(id: string, sql: Pick<Transaction, 'get'>): Promise<Approved> {
    const row = await sql.get<Row>('SELECT * FROM session_read_broker_deployments WHERE id=?', id);
    if (!row || !['claimed', 'launched'].includes(row.state)) throw refused();
    return JSON.parse(row.data_json) as Approved;
  }
  private binding(approved: Approved): ReadBrokerBinding {
    const { deployment } = approved;
    return {
      ...deployment.binding,
      ...launchIds(deployment.binding.namespace, deployment.operationKey),
    };
  }
  /** Operator explicitly approves a previously accepted public-authority manifest, not arbitrary tool arguments.
   * Its artifact bytes are exactly the closed policy schema, and the accepted review must name that artifact.
   * Runtime creation remains the normal accounted launcher; this accepts only an already-ready dedicated Modal sandbox.
   */
  async approve(
    owner: Caller,
    input: {
      control: SessionControl & { hostRef: string };
      deployment: Omit<ReadBrokerDeployment, 'binding'> & {
        binding: Omit<ReadBrokerDeployment['binding'], 'manifestId'>;
      };
      policyArtifactId: string;
      policySha256: string;
      reviewId: string;
      reviewSha256: string;
    },
  ): Promise<string> {
    if (this.state.ambient || this.state.readScope) throw refused();
    try {
      // Clone before any await: trusted approval must not race mutation of its inputs.
      owner = structuredClone(owner);
      input = structuredClone(input);
      const observed = await this.sandboxes
        .runtimes(owner)
        .inspect(input.deployment.binding.sandboxId);
      const sandbox = observed.sandbox;
      if (
        sandbox.provider !== 'modal' ||
        sandbox.state !== 'ready' ||
        !sandbox.native_id ||
        sandbox.namespace !== input.deployment.binding.namespace ||
        !sandbox.request.protected_runtime ||
        !sandbox.lease_expires_at ||
        sandbox.lease_expires_at.toDate().getTime() <= this.clock()
      )
        throw refused();
      return await this.state.transaction(async (tx) => {
        requireAdministrator(
          await this.scope.require(owner, 'admin', tx),
          'read_broker_denied',
          'Public authority read was refused',
        );
        const review = await this.reviews.get(owner, input.reviewId, tx);
        if (
          review.status !== 'submitted' ||
          review.verdict !== 'pass' ||
          review.projectId !== owner.projectId ||
          sha256Hex(canonical(review)) !== input.reviewSha256 ||
          !review.artifactIds.includes(input.policyArtifactId)
        )
          throw refused();
        const { artifact, bytes } = await this.artifacts.bytes(owner, input.policyArtifactId, tx);
        if (artifact.projectId !== owner.projectId || sha256Hex(bytes) !== input.policySha256)
          throw refused();
        const policy = readBrokerPolicySchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        );
        if (
          policy.projectId !== owner.projectId ||
          policy.projectId !== input.deployment.binding.projectId ||
          policy.assignmentId !== input.deployment.binding.assignmentId ||
          policy.revision !== input.deployment.binding.revision
        )
          throw refused();
        const id = newId('rbdep');
        const approved: Approved = {
          id,
          owner,
          control: input.control,
          deployment: {
            ...input.deployment,
            binding: { ...input.deployment.binding, manifestId: id },
          },
          policy,
          reviewId: review.id,
          reviewHash: input.reviewSha256,
          nativeId: sandbox.native_id!,
        };
        await this.sessions.readBrokerAuthority(owner, input.control, this.binding(approved), tx);
        await tx.run(
          'INSERT INTO session_read_broker_deployments(id,data_json,sandbox_id,state) VALUES(?,?,?,?)',
          id,
          canonical(approved),
          sandbox.id,
          'approved',
        );
        return id;
      });
    } catch {
      throw refused();
    }
  }
  async provision(deploymentId: string) {
    let owner: Caller | undefined;
    return provisionReadBroker(
      this.broker,
      {
        claim: async (id) =>
          this.state.transaction(async (tx) => {
            const row = await tx.get<Row>(
              'SELECT * FROM session_read_broker_deployments WHERE id=? FOR UPDATE',
              id,
            );
            if (!row || row.state !== 'approved') throw refused();
            const approved = JSON.parse(row.data_json) as Approved;
            owner = approved.owner;
            await tx.run(
              "UPDATE session_read_broker_deployments SET state='claimed' WHERE id=?",
              id,
            );
            return approved.deployment;
          }),
        launch: (sandboxId, request) => {
          if (!owner) throw refused();
          return this.sandboxes.runtimes(owner).launch(sandboxId, request);
        },
        record: async (id, grantId, receipt) => {
          await this.state.transaction(async (tx) => {
            const row = await tx.get<Row>(
              'SELECT * FROM session_read_broker_deployments WHERE id=? FOR UPDATE',
              id,
            );
            if (row?.state !== 'claimed') throw refused();
            await tx.run(
              "UPDATE session_read_broker_deployments SET state='launched',grant_id=?,receipt_json=? WHERE id=?",
              grantId,
              JSON.stringify(receipt),
              id,
            );
          });
        },
        failed: async (id, grantId, revoked) => {
          await this.state.transaction((tx) =>
            tx.run(
              "UPDATE session_read_broker_deployments SET state='failed',grant_id=?,revocation_uncertain=?::boolean WHERE id=? AND state='claimed'",
              grantId ?? null,
              String(!revoked),
              id,
            ),
          );
        },
      },
      deploymentId,
    );
  }
  /** Internal operator revocation: state changes first, so any in-flight read's final check refuses. */
  async revoke(owner: Caller, deploymentId: string) {
    try {
      await this.state.transaction(async (tx) => {
        requireAdministrator(
          await this.scope.require(owner, 'admin', tx),
          'read_broker_denied',
          'Public authority read was refused',
        );
        const row = await tx.get<Row>(
          'SELECT * FROM session_read_broker_deployments WHERE id=? FOR UPDATE',
          deploymentId,
        );
        if (!row || (JSON.parse(row.data_json) as Approved).owner.projectId !== owner.projectId)
          throw refused();
        await tx.run(
          "UPDATE session_read_broker_deployments SET state='revoked' WHERE id=?",
          deploymentId,
        );
      });
    } catch {
      throw refused();
    }
  }
  async ready(token: string) {
    await this.broker.ready(token);
    return { ready: true as const };
  }
  /** Possession is confined to the protected receiver; peer comes from the immutable DB binding, never request JSON. */
  async read(token: string, input: unknown) {
    const peer = await this.broker.peer(token);
    return this.broker.call(token, peer, input);
  }
}
