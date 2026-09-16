import { postgresMigrations } from './agents.postgres.js';
import { createHash } from 'node:crypto';
import {
  check,
  digest,
  newId,
  type Caller,
  type DelegationSource,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { Agent, AgentRegistration } from './types.js';

export const sessionToken = /^ms_[A-Za-z0-9_-]{43}$/;
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
          postgres: postgresMigrations[1],
          sql: `
      CREATE TABLE agents(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id), owner_hash TEXT NOT NULL,
        runner_id TEXT NOT NULL, request_id TEXT NOT NULL, token_hash TEXT UNIQUE,
        fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','retired')), agent_json TEXT NOT NULL,
        UNIQUE(owner_hash,runner_id,request_id));
      CREATE TRIGGER agents_no_delete BEFORE DELETE ON agents BEGIN SELECT RAISE(ABORT,'Agent history is retained'); END;
      CREATE TRIGGER agents_immutable BEFORE UPDATE ON agents
        WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.actor_id IS NOT OLD.actor_id OR
          NEW.owner_hash IS NOT OLD.owner_hash OR NEW.runner_id IS NOT OLD.runner_id OR NEW.request_id IS NOT OLD.request_id OR
          NEW.token_hash IS NOT OLD.token_hash OR NEW.fingerprint IS NOT OLD.fingerprint OR OLD.status='retired' OR
          json_extract(NEW.agent_json,'$.source') IS NOT json_extract(OLD.agent_json,'$.source') OR
          json_extract(NEW.agent_json,'$.sessionId') IS NOT json_extract(OLD.agent_json,'$.sessionId') OR
          json_extract(NEW.agent_json,'$.persistent') IS NOT json_extract(OLD.agent_json,'$.persistent') OR
          json_extract(NEW.agent_json,'$.contextEpoch') < json_extract(OLD.agent_json,'$.contextEpoch')
        BEGIN SELECT RAISE(ABORT,'Agent identity and source are immutable'); END;
    `,
        },
      ]);
    };
  }
  async create(
    caller: Caller,
    input: AgentRegistration,
    tx: Transaction,
    persistent = true,
  ): Promise<Agent> {
    check(
      input &&
        typeof input.name === 'string' &&
        input.name.trim().length > 0 &&
        input.name.length <= 200 &&
        typeof input.runnerId === 'string' &&
        input.runnerId.length > 0 &&
        input.runnerId.length <= 200 &&
        typeof input.requestId === 'string' &&
        input.requestId.length > 0 &&
        input.requestId.length <= 256 &&
        sessionToken.test(input.secret),
      'invalid_agent',
      'Agent requires a name, runner, request and ms_ secret',
    );
    const source = await this.scope.delegationSource(caller, tx),
      owner = digest(source);
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
    const source = await this.scope.delegationSource(caller, tx),
      agent = await this.get(id, tx);
    check(
      digest(source) === digest(agent.source),
      'agent_forbidden',
      'Agent belongs to another source authority',
      403,
    );
    return agent;
  }
  async authenticate(secret: string, tx: Transaction): Promise<Agent> {
    check(
      typeof secret === 'string' && sessionToken.test(secret),
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
  async require(agent: Agent, tx: Transaction): Promise<void> {
    check(agent.status === 'active', 'agent_retired', 'Agent has been retired', 401);
    await this.scope.requireDelegation(agent.source, 'read', tx);
  }
  async findToken(secret: string, tx: Transaction): Promise<boolean> {
    return !!(await tx.get('SELECT id FROM agents WHERE token_hash=?', tokenDigest(secret)));
  }
  async list(caller: Caller, tx: Transaction): Promise<Agent[]> {
    const source = await this.scope.delegationSource(caller, tx);
    return (
      await tx.all<AgentRow>(
        tx.dialect === 'postgres'
          ? 'SELECT * FROM agents WHERE owner_hash=? ORDER BY _merv_rowid'
          : 'SELECT * FROM agents WHERE owner_hash=? ORDER BY rowid',
        digest(source),
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
      typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 200,
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
