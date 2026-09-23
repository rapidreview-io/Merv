import { postgresMigrations } from './agents.postgres.js';
import { createHash } from 'node:crypto';
import { ownerOf } from './common.js';
import {
  visible,
  check,
  digest,
  newId,
  sessionSecretPattern,
  type Caller,
  type DelegationSource,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { Agent, AgentRegistration } from './types.js';

export const tokenDigest = (secret: string) => createHash('sha256').update(secret).digest('hex');
export function sourceCaller(source: DelegationSource): Caller {
  const base = { actorId: source.actorId, projectId: source.projectId };
  if (source.kind === 'actor') return { ...base, credentialId: source.credentialId };
  if (source.kind === 'key')
    return { ...base, key: { id: source.keyId, membershipId: source.membershipId } };
  // Delegation follows the captured membership epoch, not the original short-lived login JWT.
  return {
    ...base,
    human: {
      issuer: source.issuer,
      subject: source.subject,
      membershipId: source.membershipId,
      expiresAt: '9999-12-31T23:59:59.999Z',
    },
  };
}
interface AgentRow {
  id: string;
  owner_hash: string;
  token_hash: string | null;
  fingerprint: string;
  agent_json: string;
}

/** Agent identity and continuity belong to Sessions; Scope stores its security actor. */
export class AgentDirectory {
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private state: State,
    private scope: Scope,
    private clock: () => number,
  ) {
    this.initialize = async () => {
      await state.migrate('agents', [
        {
          version: 1,
          sql: postgresMigrations[1],
        },
      ]);
    };
  }
  /** Sessions parsed the input: a registration, or the implicit agent of an offer. */
  async create(
    caller: Caller,
    input: AgentRegistration,
    tx: Transaction,
    persistent = true,
  ): Promise<Agent> {
    const { source, hash: owner } = await ownerOf(this.scope, caller, tx);
    const fingerprint = digest({ name: input.name, secret: tokenDigest(input.secret), persistent });
    const old = await tx.get<AgentRow>(
      'SELECT * FROM agents WHERE owner_hash=? AND runner_id=? AND request_id=?',
      owner,
      input.runnerId,
      input.requestId,
    );
    if (old) {
      check(
        old.fingerprint === fingerprint,
        'request_conflict',
        'Agent registration was already used for different input',
        409,
      );
      return JSON.parse(old.agent_json);
    }
    check(
      !(await tx.get('SELECT id FROM agents WHERE token_hash=?', tokenDigest(input.secret))) &&
        !(await tx.get(
          'SELECT id FROM worker_sessions WHERE token_hash=?',
          tokenDigest(input.secret),
        )),
      'session_secret_used',
      'Session secret was already used',
      409,
    );
    const id = newId('agent'),
      sessionId = newId('agent_session');
    const actor = await this.scope.createSessionActor(
      source,
      { sessionId, agentId: id, name: input.name, role: 'reader' },
      tx,
    );
    const agent: Agent = {
      id,
      sessionId,
      actorId: actor.id,
      projectId: caller.projectId,
      source,
      runnerId: input.runnerId,
      name: input.name.trim(),
      persistent,
      status: 'active',
      contextEpoch: 0,
      createdAt: new Date(this.clock()).toISOString(),
      retiredAt: null,
    };
    await tx.run(
      'INSERT INTO agents(id,project_id,actor_id,owner_hash,runner_id,request_id,token_hash,fingerprint,status,agent_json) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id,
      caller.projectId,
      actor.id,
      owner,
      input.runnerId,
      input.requestId,
      persistent ? tokenDigest(input.secret) : null,
      fingerprint,
      'active',
      JSON.stringify(agent),
    );
    await this.state.appendEvent(tx, {
      projectId: agent.projectId,
      actorId: caller.actorId,
      type: 'agent.registered',
      subjectId: id,
      data: { agentId: id, agentSessionId: sessionId, workerActorId: actor.id },
    });
    return agent;
  }
  async get(id: string, tx: Transaction): Promise<Agent> {
    const row = await tx.get<AgentRow>('SELECT * FROM agents WHERE id=?', id);
    check(row, 'agent_not_found', 'Agent not found', 404);
    return JSON.parse(row.agent_json);
  }
  async controlled(caller: Caller, id: string, tx: Transaction): Promise<Agent> {
    const owner = await ownerOf(this.scope, caller, tx),
      agent = await this.get(id, tx);
    check(agent.projectId === caller.projectId, 'agent_not_found', 'Agent not found', 404);
    check(
      owner.hash === digest(agent.source),
      'agent_forbidden',
      'Agent belongs to another source authority',
      403,
    );
    return agent;
  }
  async authenticate(secret: string, tx: Transaction): Promise<Agent> {
    check(
      typeof secret === 'string' && sessionSecretPattern.test(secret),
      'unauthorized',
      'Invalid agent credential',
      401,
    );
    const row = await tx.get<AgentRow>(
      'SELECT * FROM agents WHERE token_hash=?',
      tokenDigest(secret),
    );
    check(row, 'unauthorized', 'Invalid agent credential', 401);
    const agent: Agent = JSON.parse(row.agent_json);
    await this.require(agent, tx);
    return agent;
  }
  /** The agent's own call answers 401; a controller naming a retired agent gets a conflict. */
  async require(agent: Agent, tx: Transaction, status = 401): Promise<void> {
    check(agent.status === 'active', 'agent_retired', 'Agent has been retired', status);
    await this.scope.requireDelegation(agent.source, 'read', tx);
  }
  async findToken(secret: string, tx: Transaction): Promise<boolean> {
    return !!(await tx.get('SELECT id FROM agents WHERE token_hash=?', tokenDigest(secret)));
  }
  async list(caller: Caller, tx: Transaction): Promise<Agent[]> {
    return (
      await tx.all<AgentRow>(
        'SELECT * FROM agents WHERE owner_hash=? ORDER BY _merv_rowid',
        (await ownerOf(this.scope, caller, tx)).hash,
      )
    ).map((row) => JSON.parse(row.agent_json));
  }
  async retire(agent: Agent, reason: string, tx: Transaction): Promise<Agent> {
    if (agent.status === 'retired') return agent;
    agent.status = 'retired';
    agent.retiredAt = new Date(this.clock()).toISOString();
    await this.save(agent, tx);
    await this.scope.retireSessionActor(agent.actorId, reason, tx);
    await this.state.appendEvent(tx, {
      projectId: agent.projectId,
      actorId: 'system:sessions',
      type: 'agent.retired',
      subjectId: agent.id,
      data: { agentSessionId: agent.sessionId, reason },
    });
    return agent;
  }
  async reset(agent: Agent, reason: string, tx: Transaction): Promise<Agent> {
    await this.require(agent, tx);
    check(
      typeof reason === 'string' && visible(reason) && reason.length <= 200,
      'invalid_reason',
      'Context reset requires a short reason',
    );
    agent.contextEpoch++;
    await this.save(agent, tx);
    await this.state.appendEvent(tx, {
      projectId: agent.projectId,
      actorId: agent.actorId,
      type: 'agent.context_reset',
      subjectId: agent.id,
      data: { contextEpoch: agent.contextEpoch, reason },
    });
    return agent;
  }
  private async save(agent: Agent, tx: Transaction) {
    await tx.run(
      'UPDATE agents SET status=?,agent_json=? WHERE id=?',
      agent.status,
      JSON.stringify(agent),
      agent.id,
    );
  }
}
