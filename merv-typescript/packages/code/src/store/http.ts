import { bootMaintenance } from '@merv/contracts/maintenance';
/** Standard Git smart HTTP. Git owns its wire protocol; Merv owns admission and retained refs. */
import { randomBytes, createHash, createPublicKey, publicEncrypt, constants } from 'node:crypto';
import { createServer } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonical,
  check,
  digest,
  MervError,
  newId,
  now,
  type Caller,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import { admit, defaultLimits } from './admission.js';
import { CodeRepositories } from './repository.js';
import { waitGitOwner } from '../git-owner.js';
import { gitHttp } from './native-http.js';
import { workBranch, workRef, unitRef } from './refs.js';
import { pendingMerge, verifyResolution } from '../pending-merge.js';
import type { CodeWriterService, WriterFence } from '../writers.js';
import type { CodeStoreOperation } from './protocol.js';

export interface GitGrantInput {
  sessionId: string;
  runnerId: string;
  hostRef?: string;
  unitId: string;
  generation: number | null;
  leaseId: string;
  mode: 'read' | 'write';
}
interface Grant extends GitGrantInput {
  projectId: string;
  actorId: string;
  audience: 'runner' | 'agent' | 'shutdown' | 'capture';
  cleanup?: { allocationId: string; epoch: number; credentialHash: string };
}
interface AccountGitGrant {
  audience: 'account';
  projectId: string;
  mode: 'read' | 'write';
  expiresAt: string;
}
interface Access {
  caller: Caller;
  grant?: Grant;
  accountGrant?: AccountGitGrant;
}
interface Update {
  old: string;
  next: string;
  ref: string;
}
interface Push {
  projectId: string;
  actorId: string;
  updates: Update[];
  fence?: WriterFence;
  owner?: string;
  unitId?: string;
  merge?: { plan: string; left: string; right: string; firstMerge: string | null };
}
interface PushRow {
  id: string;
  payload_json: string;
  status: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const oid = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const zero = (value: string) => /^0+$/.test(value);
const schema = `
CREATE TABLE code_git_credentials (
 token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, caller_json TEXT NOT NULL,
 grant_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX code_git_credentials_project ON code_git_credentials(project_id);
CREATE TABLE code_git_pushes (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('prepared','completed')), created_at TEXT NOT NULL,
 completed_at TEXT
);
CREATE INDEX code_git_pushes_pending ON code_git_pushes(status);
`;

/** A private, generated hook. No code, config, path or executable from a pushed tree runs. */
const hook = `#!${process.execPath}
const net = require('node:net');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 65536) process.exit(1); });
process.stdin.on('end', () => {
 const socket = net.connect(process.env.MERV_GIT_SOCKET);
 socket.on('error', () => process.exit(1));
 socket.setTimeout(60000, () => process.exit(1));
 socket.on('connect', () => socket.end(JSON.stringify({stage:process.argv[2] || 'admit',updates:input,objects:process.env.GIT_OBJECT_DIRECTORY || ''})));
 let reply = '';
 socket.on('data', chunk => reply += chunk);
 socket.on('end', () => { if (reply !== 'ok') { process.stderr.write(reply.slice(0,4096) + '\\n'); process.exitCode = 1; } });
});
`;

export class CodeGitRemote {
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly repositories: CodeRepositories,
    private readonly writers: CodeWriterService,
    private readonly fault: (
      point: 'after_objects' | 'after_journal' | 'after_refs',
    ) => void = () => {},
  ) {}

  async initialize(): Promise<void> {
    await this.state.migrate('code_git_remote', {
      1: schema,
      2: `
CREATE OR REPLACE FUNCTION code_git_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
 IF NEW.generation IS DISTINCT FROM OLD.generation AND EXISTS (
  SELECT 1 FROM code_git_pushes WHERE project_id=OLD.project_id AND status='prepared'
  AND payload_json::jsonb #>> '{fence,unitId}'=OLD.unit_id
 ) THEN RAISE EXCEPTION USING MESSAGE='An admitted Git push must finish before another writer starts', ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$merv$;
CREATE TRIGGER code_git_generation BEFORE UPDATE ON code_workspaces FOR EACH ROW EXECUTE FUNCTION code_git_generation_guard();
`,
      3: `
ALTER TABLE code_git_pushes DROP CONSTRAINT code_git_pushes_status_check;
ALTER TABLE code_git_pushes ADD CONSTRAINT code_git_pushes_status_check CHECK(status IN ('prepared','completed','rejected','partial','conflict'));
ALTER TABLE code_git_pushes ADD COLUMN outcome_json TEXT;
CREATE OR REPLACE FUNCTION code_git_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
 IF NEW.generation IS DISTINCT FROM OLD.generation AND EXISTS (
  SELECT 1 FROM code_git_pushes WHERE project_id=OLD.project_id AND status IN ('prepared','conflict')
  AND COALESCE(payload_json::jsonb #>> '{fence,unitId}',payload_json::jsonb ->> 'unitId')=OLD.unit_id
 ) THEN RAISE EXCEPTION USING MESSAGE='A native Git receiver must settle before another writer starts', ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$merv$;
`,
    });
    // Automatic startup recovery waits; admitted Git requests still reconcile their own project.
    if (!bootMaintenance.active) await this.recover();
  }

  /** Observe native outcomes after the receiver exits; a proposal never authorizes replay. */
  async recover(): Promise<void> {
    const projects = await this.state.read((sql) =>
      sql.all<{ project_id: string }>(
        "SELECT DISTINCT project_id FROM code_git_pushes WHERE status IN ('prepared','conflict')",
      ),
    );
    for (const { project_id } of projects)
      await this.repositories.run(project_id, () => this.recoverProject(project_id));
  }

  private async recoverProject(projectId: string): Promise<void> {
    const pending = await this.state.read((sql) =>
      sql.all<PushRow>(
        "SELECT id,payload_json,status FROM code_git_pushes WHERE project_id=? AND status IN ('prepared','conflict') ORDER BY created_at,id",
        projectId,
      ),
    );
    for (const row of pending) await this.reconcile(row.id, JSON.parse(row.payload_json) as Push);
  }

  /** Read live refs, not a second synchronization ledger. Local working trees are unknowable here. */
  async syncStatus(caller: Caller) {
    await this.scope.require(caller, 'read');
    const project = await this.state.read((sql) =>
      sql.get<{ main_json: string }>(
        'SELECT main_json FROM code_projects WHERE project_id=?',
        caller.projectId,
      ),
    );
    const baselineOid = project ? (JSON.parse(project.main_json) as { oid: string }).oid : null;
    const available = await this.repositories.exists(caller.projectId);
    const lines = available
      ? (
          await this.repositories.git.ok(
            ['for-each-ref', '--count=201', '--format=%(refname) %(objectname)', 'refs/heads/'],
            { env: this.repositories.environment(caller.projectId) },
          )
        )
          .toString()
          .trim()
          .split('\n')
          .filter(Boolean)
      : [];
    const userBranches = lines.slice(0, 200).flatMap((line) => {
      const [ref, headOid] = line.split(' ');
      const name = ref!.slice('refs/heads/'.length);
      return name === 'merv' ||
        name.startsWith('merv/') ||
        name === 'merv-main' ||
        name.startsWith('merv-main/')
        ? []
        : [{ name, ref: ref!, headOid: headOid! }];
    });
    return {
      remotePath: `/git/${encodeURIComponent(caller.projectId)}.git`,
      available,
      observedAt: now(),
      baselineOid,
      baselinePolicy: 'reviewed_integration' as const,
      userBranches,
      truncated: lines.length > 200,
      localWorkingTree: 'unknown' as const,
    };
  }

  /** A native MCP user delegates one project's Git access without exposing a bearer to chat.
   * Every Git request and push admission rechecks the source key's live membership. */
  async issueAccount(caller: Caller, input: { publicKey: string; mode: 'read' | 'write' }) {
    check(
      caller.key && !caller.session && !caller.managed,
      'code_git_account_required',
      'Use the signed-in account connection; workers must use assigned Git credentials',
      403,
    );
    check(
      input.mode === 'read' || input.mode === 'write',
      'invalid_input',
      'Invalid Git access mode',
    );
    check(
      typeof input.publicKey === 'string' &&
        input.publicKey.length <= 4096 &&
        input.publicKey.startsWith('-----BEGIN PUBLIC KEY-----'),
      'invalid_input',
      'Supply an RSA public key',
    );
    let key;
    try {
      key = createPublicKey(input.publicKey);
    } catch {
      throw new MervError('invalid_input', 'Supply an RSA public key', 400);
    }
    check(
      key.asymmetricKeyType === 'rsa' &&
        [2048, 3072, 4096].includes(key.asymmetricKeyDetails?.modulusLength ?? 0),
      'invalid_input',
      'Use a 2048, 3072 or 4096 bit RSA public key',
    );
    const token = `mg_${randomBytes(32).toString('base64url')}`;
    const grant: AccountGitGrant = {
      audience: 'account',
      projectId: caller.projectId,
      mode: input.mode,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    const encryptedToken = publicEncrypt(
      { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(token),
    ).toString('base64');
    await this.state.transaction(async (tx) => {
      // User branches follow project write permission; protected refs stay admission-owned.
      await this.scope.require(caller, input.mode === 'write' ? 'write' : 'read', tx);
      await tx.run(
        'INSERT INTO code_git_credentials(token_hash,project_id,caller_json,grant_json,created_at) VALUES(?,?,?,?,?)',
        hash(token),
        caller.projectId,
        canonical(caller),
        canonical(grant),
        now(),
      );
    });
    return {
      url: `/git/${encodeURIComponent(caller.projectId)}.git`,
      username: 'merv',
      mode: grant.mode,
      expiresAt: grant.expiresAt,
      encryption: 'RSA-OAEP-SHA256',
      encryptedToken,
    };
  }

  /** The workspace protocol checked runner ownership before minting these separate capabilities. */
  async issue(
    caller: Caller,
    input: GitGrantInput,
  ): Promise<{ url: string; token: string; agentToken: string }> {
    check(!caller.session, 'session_forbidden', 'Only the runner prepares Git access', 403);
    check(
      !caller.managed || caller.managed.boundSessionId === input.sessionId,
      'session_forbidden',
      'The runner is bound to another session',
      403,
    );
    const create = async (audience: Grant['audience']) => {
      const token = `mg_${randomBytes(32).toString('base64url')}`;
      const grant: Grant = {
        ...input,
        projectId: caller.projectId,
        actorId: caller.actorId,
        audience,
      };
      await this.state.transaction(async (tx) => {
        await this.scope.require(caller, 'read', tx);
        await this.live(tx, grant, false);
        await tx.run(
          'INSERT INTO code_git_credentials(token_hash,project_id,caller_json,grant_json,created_at) VALUES(?,?,?,?,?)',
          hash(token),
          caller.projectId,
          canonical(caller),
          canonical(grant),
          now(),
        );
      });
      return token;
    };
    return {
      url: `/git/${encodeURIComponent(caller.projectId)}.git`,
      token: await create('runner'),
      agentToken: await create('agent'),
    };
  }

  /** The controller attests process stop before receiving this runner-only capture capability. */
  async issueCapture(
    caller: Caller,
    input: Omit<GitGrantInput, 'mode'> & { stopped: true },
  ): Promise<{ url: string; token: string }> {
    check(
      !caller.session &&
        input.stopped &&
        (!caller.managed ||
          caller.managed.cleanup ||
          caller.managed.boundSessionId === input.sessionId),
      'session_forbidden',
      'Only the assigned runner may seal its stopped assignment',
      403,
    );
    const token = `mg_${randomBytes(32).toString('base64url')}`;
    const { stopped: _stopped, ...assignment } = input;
    const grant: Grant = {
      ...assignment,
      mode: 'write',
      projectId: caller.projectId,
      actorId: caller.actorId,
      audience: 'capture',
      ...(caller.managed?.cleanup
        ? {
            cleanup: {
              allocationId: caller.managed.allocationId,
              epoch: caller.managed.epoch,
              credentialHash: caller.managed.credentialHash,
            },
          }
        : {}),
    };
    await this.state.transaction(async (tx) => {
      await this.authorized({ caller, grant }, true, tx);
      await tx.run(
        'INSERT INTO code_git_credentials(token_hash,project_id,caller_json,grant_json,created_at) VALUES(?,?,?,?,?)',
        hash(token),
        caller.projectId,
        canonical(caller),
        canonical(grant),
        now(),
      );
    });
    return { url: `/git/${encodeURIComponent(caller.projectId)}.git`, token };
  }

  /** A new, explicit capability to capture a stopped work unit before its machine is released. */
  async issueShutdown(
    caller: Caller,
    input: Omit<GitGrantInput, 'mode'>,
  ): Promise<{ url: string; token: string }> {
    check(
      !caller.session &&
        (!caller.managed ||
          caller.managed.cleanup ||
          caller.managed.boundSessionId === input.sessionId),
      'session_forbidden',
      'Only the assigned runner may capture shutdown progress',
      403,
    );
    const token = `mg_${randomBytes(32).toString('base64url')}`;
    const grant: Grant = {
      ...input,
      mode: 'write',
      projectId: caller.projectId,
      actorId: caller.actorId,
      audience: 'shutdown',
      ...(caller.managed
        ? {
            cleanup: {
              allocationId: caller.managed.allocationId,
              epoch: caller.managed.epoch,
              credentialHash: caller.managed.credentialHash,
            },
          }
        : {}),
    };
    await this.state.transaction(async (tx) => {
      if ((caller.managed as { cleanup?: boolean } | undefined)?.cleanup)
        await this.cleanup(tx, grant);
      else await this.scope.require(caller, 'read', tx);
      await this.live(tx, grant, true);
      await tx.run(
        'INSERT INTO code_git_credentials(token_hash,project_id,caller_json,grant_json,created_at) VALUES(?,?,?,?,?)',
        hash(token),
        caller.projectId,
        canonical(caller),
        canonical(grant),
        now(),
      );
    });
    return { url: `/git/${encodeURIComponent(caller.projectId)}.git`, token };
  }

  private async cleanup(sql: Sql, grant: Grant): Promise<void> {
    const cleanup = grant.cleanup;
    check(
      cleanup && (grant.audience === 'shutdown' || grant.audience === 'capture'),
      'managed_runner_forbidden',
      'Shutdown authority is required',
      403,
    );
    const row = await sql.get<{
      epoch: number | string;
      project_id: string;
      control_hash: string;
      source_json: string;
      receipt_json: string | null;
      revoked_at: string | null;
    }>(
      `SELECT r.epoch,r.project_id,r.control_hash,r.source_json,s.receipt_json,c.revoked_at
       FROM session_managed_runners r JOIN session_managed_shutdowns s ON s.allocation_id=r.allocation_id AND s.epoch=r.epoch
       JOIN session_managed_assignments a ON a.allocation_id=r.allocation_id AND a.session_id=? AND a.runner_id=?
       JOIN identity_credentials c ON c.token_hash=r.control_hash AND c.kind='managed-control'
       WHERE r.allocation_id=?`,
      grant.sessionId,
      grant.runnerId,
      cleanup.allocationId,
    );
    check(
      row &&
        row.project_id === grant.projectId &&
        Number(row.epoch) === cleanup.epoch &&
        row.control_hash === cleanup.credentialHash &&
        row.receipt_json === null &&
        row.revoked_at === null &&
        JSON.parse(row.source_json).actorId === grant.actorId,
      'managed_runner_forbidden',
      'The shutdown request or allocation is no longer current',
      403,
    );
  }

  private async live(sql: Sql, grant: Grant, write: boolean): Promise<void> {
    if (grant.cleanup) await this.cleanup(sql, grant);
    const session = await sql.get<{
      runner_id: string;
      instance_id: string;
      status: string;
      session_json: string;
    }>(
      'SELECT runner_id,instance_id,status,session_json FROM worker_sessions WHERE id=? AND project_id=?',
      grant.sessionId,
      grant.projectId,
    );
    const detail = session
      ? (JSON.parse(session.session_json) as {
          hostRef?: string | null;
          execution?: { policy?: { readOnly?: boolean } };
        })
      : null;
    check(
      session?.runner_id === grant.runnerId &&
        session.instance_id === grant.unitId &&
        (!grant.hostRef ||
          detail?.hostRef === grant.hostRef ||
          (session.status === 'offered' && detail?.hostRef == null)),
      'code_git_credential_stale',
      'Git assignment has ended or changed',
      403,
    );
    if (!['shutdown', 'capture'].includes(grant.audience) && (!write || grant.audience === 'agent'))
      check(
        session.status === 'active' || session.status === 'offered',
        'code_git_credential_stale',
        'Git assignment has ended',
        403,
      );
    if (!write && !['shutdown', 'capture'].includes(grant.audience)) return;
    check(
      grant.mode === 'write' && !detail?.execution?.policy?.readOnly,
      'code_git_read_only',
      'This Git credential is read-only',
      403,
    );
    const row = await this.writers.row(sql, grant.projectId, grant.unitId);
    check(
      row &&
        Number(row.generation) === grant.generation &&
        row.writer_session_id === grant.sessionId &&
        row.writer_lease_id === grant.leaseId,
      'code_generation_stale',
      'Another writer owns this branch',
      403,
    );
    check(
      !row.blocked_by && !row.quarantine_operation_id,
      'code_quarantined',
      'This work is quarantined',
      409,
    );
    if (grant.audience === 'shutdown') {
      check(
        row.writer_state === 'closed' || row.writer_state === 'closing',
        'code_writer_busy',
        'Stop the writer before shutdown capture',
        409,
      );
      check(
        !(await sql.get(
          "SELECT id FROM worker_sessions WHERE project_id=? AND instance_id=? AND status IN ('offered','active') LIMIT 1",
          grant.projectId,
          grant.unitId,
        )),
        'code_writer_busy',
        'A session still uses this work unit',
        409,
      );
      return;
    }
    check(
      [
        'reserved',
        'active',
        ...(['runner', 'capture'].includes(grant.audience) ? ['closing'] : []),
      ].includes(row.writer_state),
      'code_writer_closed',
      'This writer has ended',
      403,
    );
    if (row.writer_state === 'closing' && !grant.cleanup) {
      if (grant.audience === 'capture')
        check(
          row.final_owed,
          'code_writer_closed',
          'This session no longer owes a stopped capture',
          403,
        );
      check(
        Date.parse(row.writer_changed_at ?? '') >
          Date.now() - this.writers.finalizeGraceSeconds * 1000,
        'code_writer_closed',
        'The shutdown transfer window ended',
        403,
      );
    }
  }

  private async authenticate(
    req: IncomingMessage,
    projectId: string,
    write: boolean,
  ): Promise<Access> {
    const header = req.headers.authorization ?? '';
    let token = '';
    if (/^Basic [A-Za-z0-9+/]+=*$/.test(header)) {
      const value = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const colon = value.indexOf(':');
      if (colon > 0) token = value.slice(colon + 1);
    } else if (/^Bearer [^\s]+$/i.test(header)) token = header.slice(7);
    check(token && token.length <= 4096, 'unauthorized', 'Use a Merv Git credential', 401);
    if (token.startsWith('mg_')) {
      const row = await this.state.read((sql) =>
        sql.get<{ caller_json: string; grant_json: string }>(
          'SELECT caller_json,grant_json FROM code_git_credentials WHERE token_hash=? AND project_id=?',
          hash(token),
          projectId,
        ),
      );
      check(row, 'unauthorized', 'Invalid Git credential', 401);
      const grant = JSON.parse(row.grant_json) as Grant | AccountGitGrant;
      if (grant.audience === 'account') {
        const access = { caller: JSON.parse(row.caller_json) as Caller, accountGrant: grant };
        await this.authorized(access, write);
        return access;
      }
      await this.state.read((sql) => this.live(sql, grant, write));
      return { caller: JSON.parse(row.caller_json) as Caller, grant };
    }
    const principal = token.startsWith('mk_')
      ? { kind: 'key' as const, key: await this.scope.userKeys.authenticate(token) }
      : { kind: 'actor' as const, actor: await this.scope.authenticate(token) };
    const caller = await this.scope.caller(principal, projectId, true);
    check(
      !caller.session && !caller.managed,
      'code_git_credential_required',
      'Use an assigned Git credential',
      403,
    );
    return { caller };
  }

  /** The mount is public only so normal Git Basic authentication can be handled here. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('www-authenticate', 'Basic realm="Merv Git", charset="UTF-8"');
    const match =
      /^\/git\/([A-Za-z0-9_-]{1,200})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
        url.pathname,
      );
    check(match, 'not_found', 'Unknown Git endpoint', 404);
    const [, projectId, route] = match;
    const service = route === 'info/refs' ? url.searchParams.get('service') : route;
    check(
      service === 'git-upload-pack' || service === 'git-receive-pack',
      'invalid_input',
      'Use smart Git HTTP',
    );
    check(
      route === 'info/refs'
        ? req.method === 'GET' && [...url.searchParams].length === 1
        : req.method === 'POST' && !url.search,
      'invalid_input',
      'Invalid Git method or query',
    );
    const access = await this.authenticate(req, projectId, service === 'git-receive-pack');
    await this.authorized(access, service === 'git-receive-pack');
    await this.repositories.run(projectId, async () => {
      await this.recoverProject(projectId);
      await this.authorized(access, service === 'git-receive-pack');
      await this.prepare(projectId);
      await this.repositories.transfer(() =>
        route === 'git-receive-pack'
          ? this.receive(req, res, url, access)
          : gitHttp(this.repositories, projectId, req, res, url),
      );
    });
  }

  private async authorized(access: Access, write: boolean, tx?: Transaction): Promise<void> {
    if (access.accountGrant) {
      const grant = access.accountGrant;
      check(
        access.caller.key &&
          !access.caller.session &&
          !access.caller.managed &&
          grant.projectId === access.caller.projectId &&
          Date.parse(grant.expiresAt) > Date.now(),
        'unauthorized',
        'Git credential expired; renew through the signed-in MCP connection',
        401,
      );
      check(
        !write || grant.mode === 'write',
        'code_git_read_only',
        'This Git credential is read-only',
        403,
      );
    }
    if (access.grant) {
      // A derived grant must not outlive revoked source authority. Cleanup has its own
      // deliberately narrower authorization after an allocation stops granting work.
      if (!access.grant.cleanup) await this.scope.require(access.caller, 'read', tx);
      if (access.caller.managed && !access.grant.cleanup) {
        const pending = async (sql: Sql) =>
          sql.get(
            'SELECT allocation_id FROM session_managed_shutdowns WHERE allocation_id=?',
            access.caller.managed!.allocationId,
          );
        check(
          !(tx ? await pending(tx) : await this.state.read(pending)),
          'managed_shutdown_only',
          'Only shutdown capture is available',
          403,
        );
      }
      if (tx) await this.live(tx, access.grant, write);
      else await this.state.read((sql) => this.live(sql, access.grant!, write));
    } else {
      // User-owned keys follow live membership roles. Independent machine actors keep their
      // existing admin boundary; assigned workers take the fenced grant path above.
      await this.scope.require(
        access.caller,
        write ? (access.caller.key ? 'write' : 'admin') : 'read',
        tx,
      );
    }
  }

  private async prepare(projectId: string): Promise<void> {
    const project = await this.state.read((sql) =>
      sql.get<{ repository_id: string; main_json: string; store_json: string | null }>(
        'SELECT repository_id,main_json,store_json FROM code_projects WHERE project_id=?',
        projectId,
      ),
    );
    check(
      project?.store_json && (await this.repositories.exists(projectId)),
      'code_base_pending',
      'The project repository is being prepared',
      409,
    );
    await this.repositories.validate(projectId, project.repository_id);
    const env = this.repositories.environment(projectId);
    const main = (JSON.parse(project.main_json) as { oid: string }).oid;
    const aliases: [string, string][] = [['refs/heads/merv-main', main]];
    const rows = await this.state.read((sql) =>
      sql.all<{ unit_id: string; head_oid: string | null; base_json: string | null }>(
        'SELECT unit_id,head_oid,base_json FROM code_workspaces WHERE project_id=? AND base_json IS NOT NULL',
        projectId,
      ),
    );
    const reserved = [
      'refs/heads/merv-main',
      ...rows.flatMap(({ unit_id }) => [`refs/heads/${workBranch(unit_id)}`, workRef(unit_id)]),
    ];
    const existing = (
      await this.repositories.git.ok(['for-each-ref', '--format=%(refname) %(objectname)'], { env })
    )
      .toString()
      .trim()
      .split('\n');
    // Detect namespace blockers before creating any aliases. Older repositories may
    // contain user history here; only an explicit operator move may disambiguate it.
    for (const entry of existing) {
      const [ref, value] = entry.split(' ');
      if (
        ref === 'refs/heads/merv' ||
        ref === 'refs/heads/merv/work' ||
        reserved.some((target) => target.startsWith(`${ref}/`) || ref.startsWith(`${target}/`))
      )
        throw new MervError(
          'code_ref_collision',
          `Reserved Git namespace is blocked by ${ref} (${value}). A repository administrator must explicitly move this ref to a non-reserved branch in the server repository, preserving its history, before retrying.`,
          409,
        );
    }
    for (const row of rows) {
      const held =
        row.head_oid ?? this.writers.base(row as Parameters<CodeWriterService['base']>[0]);
      const branch = `refs/heads/${workBranch(row.unit_id)}`;
      const visible = await this.repositories.resolve(projectId, branch);
      const legacy = await this.repositories.resolve(projectId, workRef(row.unit_id));
      let target = visible ?? legacy ?? held;
      if (visible && legacy && visible !== legacy) {
        if (await this.repositories.ancestor(projectId, visible, legacy)) target = legacy;
        else
          check(
            await this.repositories.ancestor(projectId, legacy, visible),
            'code_ref_collision',
            'The legacy work ref and visible branch diverged; map them explicitly',
            409,
          );
      }
      aliases.push([branch, target]);
    }
    for (const [ref, value] of aliases) {
      if (!(await this.repositories.resolve(projectId, `${value}^{commit}`))) continue;
      const previous = await this.repositories.resolve(projectId, ref);
      if (previous === value) continue;
      if (previous && (await this.repositories.ancestor(projectId, value, previous))) continue;
      check(
        !previous || (await this.repositories.ancestor(projectId, previous, value)),
        'code_ref_collision',
        'A reserved branch collides with existing history; map it explicitly',
        409,
      );
      await this.repositories.git.ok(
        ['update-ref', ref, value, previous ?? '0'.repeat(value.length)],
        { env },
      );
    }
    for (const row of rows)
      await this.repositories.git.ok(
        ['symbolic-ref', workRef(row.unit_id), `refs/heads/${workBranch(row.unit_id)}`],
        { env },
      );
    await this.repositories.git.ok(['symbolic-ref', 'HEAD', 'refs/heads/merv-main'], { env });
  }

  private async receive(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    access: Access,
  ): Promise<void> {
    const projectId = access.caller.projectId;
    const id = newId('gpush');
    const directory = join(this.repositories.paths(projectId).directory, 'receivers', id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Only the small hook socket uses the OS temporary directory (Unix path length limit).
    const socketDirectory = await mkdtemp(join(tmpdir(), 'merv-git-'));
    const socketPath = join(socketDirectory, 'admit.sock');
    const owner = join(directory, 'owner');
    let push: Push = { projectId, actorId: access.caller.actorId, updates: [], owner };
    const grant = access.grant;
    await this.state.transaction(async (tx) => {
      await this.authorized(access, true, tx);
      if (grant) {
        const row = (await this.writers.row(tx, projectId, grant.unitId))!;
        push.fence = {
          projectId,
          unitId: grant.unitId,
          generation: grant.generation!,
          sessionId: grant.sessionId,
          leaseId: grant.leaseId,
          expectedHead: row.head_oid ?? this.writers.base(row),
          moves: false,
        };
      }
      await tx.run(
        "INSERT INTO code_git_pushes(id,project_id,payload_json,status,created_at) VALUES(?,?,?,'prepared',?)",
        id,
        projectId,
        canonical(push),
        now(),
      );
    });
    const callbacks: Promise<void>[] = [];
    let admitted = false;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      let data = '';
      socket.on('error', () => {});
      socket.setTimeout(60_000, () => socket.destroy());
      socket.on('data', (chunk) => {
        data += chunk;
        if (data.length > 65536) socket.destroy();
      });
      socket.on('end', () => {
        callbacks.push(
          (async () => {
            const input = JSON.parse(data) as { stage: string; updates: string; objects: string };
            if (['preparing', 'committed', 'aborted'].includes(input.stage)) return;
            const updates = input.updates
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => {
                const [old, next, ref, extra] = line.split(' ');
                check(
                  !extra && oid.test(old) && oid.test(next) && ref,
                  'invalid_input',
                  'Invalid Git update',
                );
                return { old, next, ref };
              });
            if (input.stage === 'admit') {
              check(!admitted, 'invalid_input', 'Only one admission per push');
              admitted = true;
              const objects = await realpath(
                input.objects || join(this.repositories.paths(projectId).repository, 'objects'),
              );
              const base = await realpath(
                join(this.repositories.paths(projectId).repository, 'objects'),
              );
              check(
                objects === base || objects.startsWith(base + '/tmp_objdir-incoming-'),
                'invalid_input',
                'Invalid quarantine',
              );
              push = { ...(await this.admitPush(access, updates, objects)), owner };
              await this.state.transaction(async (tx) => {
                await this.authorizePush(access, push, tx);
                await tx.run(
                  "UPDATE code_git_pushes SET payload_json=? WHERE id=? AND status='prepared'",
                  canonical(push),
                  id,
                );
              });
              this.fault('after_journal');
            } else {
              check(
                input.stage === 'prepared' &&
                  admitted &&
                  updates.length > 0 &&
                  updates.every((u) =>
                    push.updates.some(
                      (p) => p.ref === u.ref && p.old === u.old && p.next === u.next,
                    ),
                  ),
                'code_git_rejected',
                'Git transaction differs from its admission',
              );
              await this.state.transaction((tx) => this.authorizePush(access, push, tx));
            }
          })().then(
            () => {
              socket.end('ok');
            },
            (error) => {
              socket.end(
                error instanceof MervError
                  ? `${error.code}: ${error.message}`
                  : 'code_git_rejected: Git admission failed',
              );
            },
          ),
        );
      });
    });
    try {
      for (const name of ['pre-receive', 'reference-transaction'])
        await writeFile(join(directory, name), hook, { mode: 0o700 });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      await gitHttp(this.repositories, projectId, req, res, url, {
        hooksPath: directory,
        socketPath,
        durableOwner: owner,
        beforeReply: async () => {
          await Promise.all(callbacks);
          this.fault('after_refs');
          await this.reconcile(id, push);
        },
      });
    } finally {
      await Promise.all(callbacks);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketDirectory, { recursive: true, force: true });
      // The journal retains the owner lease on failure; recovery must first prove quiescence.
    }
  }

  private async authorizePush(access: Access, push: Push, tx: Transaction): Promise<void> {
    await this.authorized(access, true, tx);
    if (push.fence && !['shutdown', 'capture'].includes(access.grant?.audience ?? ''))
      await this.writers.fenced(tx, push.fence, 'checkpoint', true);
  }

  private async admitPush(access: Access, updates: Update[], objects: string): Promise<Push> {
    const projectId = access.caller.projectId;
    check(
      updates.length > 0 &&
        updates.length <= 128 &&
        new Set(updates.map((u) => u.ref)).size === updates.length,
      'invalid_input',
      'Push contains too many or duplicate refs',
    );
    await this.authorized(access, true);
    const joined = {
      ...this.repositories.environment(projectId),
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(
        this.repositories.paths(projectId).repository,
        'objects',
      ),
    };
    const grant = access.grant;
    let fence: WriterFence | undefined;
    for (const update of updates) {
      check(
        !zero(update.next),
        'code_git_delete_forbidden',
        'Branch and retained-ref deletion are disabled',
        403,
      );
      check(
        (await this.repositories.git.run(['check-ref-format', update.ref])).code === 0,
        'invalid_input',
        'Invalid Git ref',
      );
      const submission =
        (grant?.audience === 'runner' || grant?.audience === 'capture') &&
        update.ref.startsWith(`refs/merv/submissions/${unitRef(grant.sessionId)}/`);
      if (submission) {
        check(
          ['parent', 'tree'].some(
            (name) => update.ref === `refs/merv/submissions/${unitRef(grant!.sessionId)}/${name}`,
          ),
          'code_git_ref_forbidden',
          'Invalid submission ref',
          403,
        );
        check(
          zero(update.old) || update.old === update.next,
          'code_submission_immutable',
          'A submission is immutable',
          409,
        );
      } else if (grant) {
        check(
          update.ref === `refs/heads/${workBranch(grant.unitId)}`,
          'code_git_ref_forbidden',
          'A worker may push only its assigned branch',
          403,
        );
        const row = await this.state.read((sql) => this.writers.row(sql, projectId, grant.unitId));
        const expectedHead = row!.head_oid ?? this.writers.base(row!);
        check(
          update.old === expectedHead,
          'code_head_conflict',
          'Fetch the current branch before pushing',
          409,
        );
        fence = {
          projectId,
          unitId: grant.unitId,
          generation: grant.generation!,
          sessionId: grant.sessionId,
          leaseId: grant.leaseId,
          expectedHead,
          moves: update.next !== expectedHead,
        };
      } else {
        check(
          update.ref.startsWith('refs/heads/') &&
            update.ref !== 'refs/heads/merv-main' &&
            !update.ref.startsWith('refs/heads/merv-main/') &&
            update.ref !== 'refs/heads/merv' &&
            !update.ref.startsWith('refs/heads/merv/'),
          'code_git_ref_forbidden',
          'merv, merv/*, merv-main, merv-main/* and retained refs are reserved',
          403,
        );
      }
      const type = (
        await this.repositories.git.ok(['cat-file', '-t', update.next], { env: joined })
      )
        .toString()
        .trim();
      check(
        type === (submission && update.ref.endsWith('/tree') ? 'tree' : 'commit'),
        'code_git_object_type',
        'This ref names the wrong object type',
      );
      if (!zero(update.old) && update.old !== update.next && !submission)
        check(
          (
            await this.repositories.git.run(
              ['merge-base', '--is-ancestor', update.old, update.next],
              { env: joined },
            )
          ).code === 0,
          'code_git_non_fast_forward',
          'Fetch and reconcile the branch; force pushes are disabled',
          409,
        );
      const current = await this.repositories.resolve(projectId, update.ref);
      check(
        current === (zero(update.old) ? null : update.old),
        'code_head_conflict',
        'The branch changed during this push',
        409,
      );
    }
    // Submission-only pushes still belong to the exact writer generation. Their
    // admitted journal fences a successor until the immutable refs are retained.
    if (grant && !fence) {
      const row = await this.state.read((sql) => this.writers.row(sql, projectId, grant.unitId));
      fence = {
        projectId,
        unitId: grant.unitId,
        generation: grant.generation!,
        sessionId: grant.sessionId,
        leaseId: grant.leaseId,
        expectedHead: row!.head_oid ?? this.writers.base(row!),
        moves: false,
      };
    }
    const project = await this.state.read((sql) =>
      sql.get<{ limits_json: string }>(
        'SELECT limits_json FROM code_projects WHERE project_id=?',
        projectId,
      ),
    );
    const configured = JSON.parse(project!.limits_json) as {
      denyGlobs?: string[];
      secretExemptGlobs?: string[];
    };
    const admission = await admit({
      git: this.repositories.git,
      repository: this.repositories.paths(projectId).repository,
      quarantine: '',
      bundle: '',
      head: updates[0].next,
      expectedHead: null,
      prerequisites: 'admitted',
      limits: {
        ...defaultLimits,
        denyGlobs: configured.denyGlobs ?? [],
        secretExemptGlobs: configured.secretExemptGlobs ?? [],
      },
      received: {
        objects,
        heads: updates.map((u) => u.next),
        objectFormat: await this.repositories.objectFormat(projectId),
      },
    });
    check(
      !admission.findings.length,
      'code_git_admission',
      'Git content failed repository admission',
      409,
    );
    let merge: Push['merge'];
    const branchUpdate =
      fence && updates.find((update) => update.ref === `refs/heads/${workBranch(fence!.unitId)}`);
    if (fence && branchUpdate) {
      const pending = await this.state.read((sql) => pendingMerge(sql, projectId, fence!.unitId));
      if (pending) {
        const head = branchUpdate.next;
        const verified = await verifyResolution(
          this.repositories.git,
          joined,
          pending.firstParent,
          pending.secondParent,
          head,
        );
        check(
          !verified.error,
          'code_resolution_unverified',
          verified.error ?? 'Invalid resolution',
          409,
        );
        merge = {
          plan: pending.plan,
          left: pending.firstParent,
          right: pending.secondParent,
          firstMerge: verified.firstMerge,
        };
      }
    }
    await this.repositories.assertRoom(projectId, admission.bytes);
    this.fault('after_objects');
    return {
      projectId,
      actorId: access.caller.actorId,
      updates,
      ...(fence ? { fence } : {}),
      ...(merge ? { merge } : {}),
    };
  }

  /** Only the native ref state decides what happened, including interrupted atomic pushes. */
  private async reconcile(id: string, push: Push): Promise<void> {
    if (push.owner) await waitGitOwner(push.owner);
    const outcomes = await Promise.all(
      push.updates.map(async (update) => {
        const actual = await this.repositories.resolve(push.projectId, update.ref);
        return {
          ...update,
          actual,
          outcome:
            actual === update.next
              ? 'applied'
              : actual === (zero(update.old) ? null : update.old)
                ? 'rejected'
                : 'conflict',
        };
      }),
    );
    const conflict = outcomes.some((u) => u.outcome === 'conflict');
    const applied = outcomes.filter((u) => u.outcome === 'applied');
    const status = conflict
      ? 'conflict'
      : !applied.length
        ? 'rejected'
        : applied.length === outcomes.length
          ? 'completed'
          : 'partial';
    // An interrupted native transaction can leave loose ref locks. No owner remains and
    // the project writer lock excludes a new receive. Clean before closing the journal so
    // a crash during cleanup retries it before releasing the generation fence.
    if (!conflict)
      for (const update of push.updates)
        await rm(join(this.repositories.paths(push.projectId).repository, update.ref + '.lock'), {
          force: true,
        }).catch((error: NodeJS.ErrnoException) => {
          if (!['ENOENT', 'ENOTDIR'].includes(error.code ?? '')) throw error;
        });
    if (!conflict && push.owner) await rm(dirname(push.owner), { recursive: true, force: true });
    await this.state.transaction(async (tx) => {
      const row = await tx.get<{ status: string }>(
        'SELECT status FROM code_git_pushes WHERE id=?',
        id,
      );
      if (!row || !['prepared', 'conflict'].includes(row.status)) return;
      const workUpdate =
        push.fence && applied.find((u) => u.ref === `refs/heads/${workBranch(push.fence!.unitId)}`);
      if (!conflict && push.fence && workUpdate) {
        const writer = await this.writers.row(tx, push.projectId, push.fence.unitId);
        check(
          Number(writer?.generation) === push.fence.generation,
          'code_generation_stale',
          'A native receiver lost its writer generation',
          409,
        );
        const head = workUpdate.next;
        if (push.merge)
          await tx.run(
            'UPDATE code_pending_merges SET head_oid=?,first_merge=? WHERE project_id=? AND unit_id=? AND plan_key=?',
            head,
            push.merge.firstMerge,
            push.projectId,
            push.fence.unitId,
            push.merge.plan,
          );
        await this.writers.advanced(tx, push.fence, { head, operationId: id, final: false });
      }
      await tx.run(
        'UPDATE code_git_pushes SET status=?,outcome_json=?,completed_at=? WHERE id=?',
        status,
        canonical(outcomes),
        now(),
        id,
      );
    });
    check(
      !conflict,
      'code_git_recovery_conflict',
      'Native Git refs differ from both ends of a pending update; operator reconciliation is required',
      409,
    );
  }

  async acknowledge(
    caller: Caller,
    input: {
      sessionId: string;
      unitId: string;
      generation: number;
      leaseId: string;
      expectedHead: string;
      proposedHead: string;
      treeOid: string;
      commandId?: string;
      kind: 'checkpoint' | 'final';
    },
  ): Promise<CodeStoreOperation> {
    const requestId = input.commandId ?? `final:${input.sessionId}`;
    const projectId = caller.projectId;
    return await this.repositories.run(projectId, async () => {
      await this.recoverProject(projectId);
      const head = await this.repositories.resolve(
        projectId,
        `refs/heads/${workBranch(input.unitId)}`,
      );
      check(
        head === input.proposedHead,
        'code_upload_required',
        'Push this commit before acknowledging it',
        409,
      );
      const tree = await this.repositories.resolve(projectId, `${head}^{tree}`);
      check(tree === input.treeOid, 'code_upload_required', 'The pushed tree differs', 409);
      const id = await this.state.transaction(async (tx) => {
        if ((caller.managed as { cleanup?: boolean } | undefined)?.cleanup) {
          check(
            input.kind === 'final',
            'managed_runner_forbidden',
            'Cleanup may only acknowledge shutdown capture',
            403,
          );
          const assignment = await tx.get<{ runner_id: string; session_json: string }>(
            'SELECT runner_id,session_json FROM worker_sessions WHERE project_id=? AND id=?',
            projectId,
            input.sessionId,
          );
          check(assignment, 'session_not_found', 'No assigned session', 404);
          await this.cleanup(tx, {
            ...input,
            projectId,
            actorId: caller.actorId,
            mode: 'write',
            audience: 'shutdown',
            runnerId: assignment.runner_id,
            hostRef: JSON.parse(assignment.session_json).hostRef,
            cleanup: caller.managed!,
          });
        } else await this.scope.require(caller, 'read', tx);
        const existing = await tx.get<{ id: string; result_json: string }>(
          'SELECT id,result_json FROM code_operations WHERE project_id=? AND principal_scope=? AND request_id=?',
          projectId,
          `session:${input.sessionId}`,
          requestId,
        );
        if (existing) {
          check(
            JSON.parse(existing.result_json).head === head,
            'request_conflict',
            'This acknowledgement already names another commit',
            409,
          );
          return existing.id;
        }
        const fence: WriterFence = {
          projectId,
          unitId: input.unitId,
          generation: input.generation,
          sessionId: input.sessionId,
          leaseId: input.leaseId,
          expectedHead: head!,
          moves: false,
        };
        const writer = await this.writers.row(tx, projectId, input.unitId);
        if (input.kind === 'final' && writer?.writer_state === 'closed') {
          check(
            writer.writer_session_id === input.sessionId &&
              writer.writer_lease_id === input.leaseId &&
              Number(writer.generation) === input.generation &&
              (writer.head_oid ?? this.writers.base(writer)) === head,
            'code_generation_stale',
            'Another writer owns this work unit',
            409,
          );
        } else await this.writers.fenced(tx, fence, input.kind, true, input.kind === 'final');
        const operationId = newId('cop');
        const at = now();
        const pending = await pendingMerge(tx, projectId, input.unitId);
        const merge = pending?.firstMerge
          ? {
              plan: pending.plan,
              left: pending.firstParent,
              right: pending.secondParent,
              firstMerge: pending.firstMerge,
            }
          : undefined;
        await tx.run(
          "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,unit_id,generation,phase,progress_json,updated_at) VALUES(?,?,?,?,'upload',?,?,'completed',?,?,?,?,?,'refs_applied',?,?)",
          operationId,
          projectId,
          `session:${input.sessionId}`,
          requestId,
          digest(input),
          canonical(input),
          canonical({ head, tree, ...(merge ? { merge } : {}) }),
          at,
          at,
          input.unitId,
          input.generation,
          canonical({ target: head, tree }),
          at,
        );
        if (input.kind === 'final')
          await this.writers.advanced(tx, fence, { head: head!, operationId, final: true });
        return operationId;
      });
      return {
        id,
        kind: 'upload',
        status: 'completed',
        phase: 'refs_applied',
        unitId: input.unitId,
        generation: input.generation,
        received: 0,
        bytes: 0,
        partBytes: 0,
        head,
        error: null,
        findings: [],
        waiting: null,
        createdAt: now(),
        updatedAt: now(),
        completedAt: now(),
      };
    });
  }

  async verifySubmission(
    projectId: string,
    input: { sessionId: string; parentOid: string; treeOid: string; unitId?: string },
  ): Promise<void> {
    for (const [name, value, type] of [
      ['parent', input.parentOid, 'commit'],
      ['tree', input.treeOid, 'tree'],
    ]) {
      check(oid.test(value), 'invalid_input', 'Invalid submission object');
      check(
        (await this.repositories.resolve(
          projectId,
          `refs/merv/submissions/${unitRef(input.sessionId)}/${name}`,
        )) === value,
        'code_submission_missing',
        'Push the exact frozen submission first',
        409,
      );
      const actual = (
        await this.repositories.git.ok(['cat-file', '-t', value], {
          env: this.repositories.environment(projectId),
        })
      )
        .toString()
        .trim();
      check(
        actual === type,
        'code_submission_missing',
        'The retained submission has the wrong object type',
        409,
      );
    }
    if (input.unitId) {
      const pending = await this.state.read((sql) => pendingMerge(sql, projectId, input.unitId!));
      if (pending) {
        const verified = await verifyResolution(
          this.repositories.git,
          this.repositories.environment(projectId),
          pending.firstParent,
          pending.secondParent,
          input.parentOid,
        );
        check(
          !verified.error && verified.firstMerge,
          'code_resolution_unverified',
          verified.error ?? 'Complete the frozen merge before submitting its resolution',
          409,
        );
      }
    }
  }

  async materializeSubmission(
    projectId: string,
    input: {
      sessionId: string;
      parentOid: string;
      treeOid: string;
      approvalId: string;
      createdAt: string;
      message: string;
      unitId: string;
    },
  ): Promise<{ head: string; tree: string; ref: string }> {
    return await this.repositories.run(projectId, async () => {
      await this.recoverProject(projectId);
      await this.verifySubmission(projectId, input);
      const ref = `refs/merv/approvals/${unitRef(input.approvalId)}`;
      const env = this.repositories.environment(projectId);
      const branch = `refs/heads/${workBranch(input.unitId)}`;
      const retained = await this.repositories.resolve(projectId, ref);
      const current = await this.repositories.resolve(projectId, branch);
      const same =
        (await this.repositories.resolve(projectId, `${input.parentOid}^{tree}`)) === input.treeOid;
      const candidate = same
        ? input.parentOid
        : (
            await this.repositories.git.ok(['commit-tree', input.treeOid, '-p', input.parentOid], {
              env: {
                ...env,
                GIT_AUTHOR_NAME: 'Merv',
                GIT_AUTHOR_EMAIL: 'code@merv.local',
                GIT_COMMITTER_NAME: 'Merv',
                GIT_COMMITTER_EMAIL: 'code@merv.local',
                GIT_AUTHOR_DATE: input.createdAt,
                GIT_COMMITTER_DATE: input.createdAt,
              },
              input: input.message + '\n',
            })
          )
            .toString()
            .trim();
      // A verified stopped-writer capture may already contain this exact submitted tree.
      // Otherwise the deterministic approval commit makes retries independent of partial ref writes.
      const head = retained ?? (current && current !== input.parentOid ? current : candidate);
      if (head !== candidate) {
        const receipts = await this.state.read((sql) =>
          sql.all<{ payload_json: string }>(
            "SELECT payload_json FROM code_operations WHERE project_id=? AND principal_scope=? AND kind='upload' AND status='completed'",
            projectId,
            `session:${input.sessionId}`,
          ),
        );
        const captured = receipts.some(({ payload_json }) => {
          const receipt = JSON.parse(payload_json);
          return (
            receipt.kind === 'final' &&
            receipt.expectedHead === input.parentOid &&
            receipt.proposedHead === head &&
            receipt.treeOid === input.treeOid &&
            receipt.unitId === input.unitId
          );
        });
        const lineage = (
          await this.repositories.git.ok(['rev-list', '--parents', '-n', '1', head], { env })
        )
          .toString()
          .trim()
          .split(/\s+/);
        check(
          captured &&
            lineage.length === 2 &&
            lineage[1] === input.parentOid &&
            (await this.repositories.resolve(projectId, `${head}^{tree}`)) === input.treeOid,
          'code_head_conflict',
          'The producer branch changed after submission',
          409,
        );
      }
      check(
        current === null || current === input.parentOid || current === head,
        'code_head_conflict',
        'The producer branch changed after submission',
        409,
      );
      const updates: Update[] = [];
      if (!retained) updates.push({ ref, old: '0'.repeat(head.length), next: head });
      if (current !== head)
        updates.push({ ref: branch, old: current ?? '0'.repeat(head.length), next: head });
      if (updates.length) {
        const id = newId('gapproval');
        const owner = join(this.repositories.paths(projectId).directory, 'receivers', id, 'owner');
        const push: Push = {
          projectId,
          unitId: input.unitId,
          actorId: 'system:code',
          updates,
          owner,
        };
        await this.state.transaction((tx) =>
          tx.run(
            "INSERT INTO code_git_pushes(id,project_id,payload_json,status,created_at) VALUES(?,?,?,'prepared',?)",
            id,
            projectId,
            canonical(push),
            now(),
          ),
        );
        try {
          await this.repositories.git.ok(['update-ref', '--stdin'], {
            env,
            durableOwner: owner,
            input: `start\n${updates.map((u) => `update ${u.ref} ${u.next} ${u.old}\n`).join('')}prepare\ncommit\n`,
          });
        } finally {
          await this.reconcile(id, push);
        }
      }
      const tree = await this.repositories.resolve(projectId, `${head}^{tree}`);
      check(
        tree === input.treeOid,
        'code_approval_conflict',
        'The approval already names another tree',
        409,
      );
      return { head, tree: input.treeOid, ref };
    });
  }
}
