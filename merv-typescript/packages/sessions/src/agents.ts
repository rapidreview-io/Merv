import { postgresMigrations } from './agents.postgres.js';
import { ownerOf } from './common.js';
import {
  check,
  digest,
  newId,
  type Caller,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { Agent } from './types.js';
import { tokenDigest } from '@merv/identity/credentials';

export { tokenDigest };
export { sourceCaller } from '@merv/scope/rules';
interface AgentRow {
  id: string;
  owner_hash: string;
  agent_json: string;
}

/** What an offer names its implicit agent by. */
interface AgentRegistration {
  name: string;
  runnerId: string;
  requestId: string;
  secret: string;
}

/**
 * Agent identity and continuity belong to Sessions; Scope stores its security actor. Every agent
 * is the implicit one of an offer. Rows of the retired continuing agents (`persistent`, with a
 * `token_hash`) stay readable as history; nothing authenticates their credentials any more.
 */
export class AgentDirectory {
  constructor(
    private state: State,
    private scope: Scope,
    private clock: () => number,
  ) {}
  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('agents', [{ version: 1, sql: postgresMigrations[1] }]);
  }
  /** The implicit agent of an offer, which Sessions parsed. */
  async create(caller: Caller, input: AgentRegistration, tx: Transaction): Promise<Agent> {
    const { source, hash: owner } = await ownerOf(this.scope, caller, tx);
    // The offer replays its own request and refuses a used secret before it gets here.
    const fingerprint = digest({
      name: input.name,
      secret: tokenDigest(input.secret),
      persistent: false,
    });
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
      persistent: false,
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
      null,
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
  /** The agent's own call answers 401; a controller naming a retired agent gets a conflict. */
  async require(agent: Agent, tx: Transaction, status = 401): Promise<void> {
    check(agent.status === 'active', 'agent_retired', 'Agent has been retired', status);
    await this.scope.requireDelegation(agent.source, 'read', tx);
  }
  async list(caller: Caller, tx: Transaction): Promise<Agent[]> {
    return (
      await tx.all<AgentRow>(
        'SELECT * FROM agents WHERE owner_hash=? ORDER BY _merv_rowid',
        (await ownerOf(this.scope, caller, tx)).hash,
      )
    ).map((row) => JSON.parse(row.agent_json));
  }
  async retire({ id }: Agent, reason: string, tx: Transaction): Promise<Agent> {
    const agent = await this.get(id, tx);
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
  private async save(agent: Agent, tx: Transaction) {
    await tx.run(
      'UPDATE agents SET status=?,agent_json=? WHERE id=?',
      agent.status,
      JSON.stringify(agent),
      agent.id,
    );
  }
}
