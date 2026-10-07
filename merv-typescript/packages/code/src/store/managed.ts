import { createHash } from 'node:crypto';
import { canonical, check, digest, now, type State, type Transaction } from '@merv/contracts';
import type { CodeRepositories } from './repository.js';

const tree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const hash = (kind: string, body: string) =>
  createHash('sha1')
    .update(`${kind} ${Buffer.byteLength(body)}\0${body}`)
    .digest('hex');

/** A deterministic root makes replay safe even after Git succeeded but SQL did not. */
export function managedRoot(projectId: string) {
  const body = `tree ${tree}\nauthor Merv <code@merv.local> 0 +0000\ncommitter Merv <code@merv.local> 0 +0000\n\nInitialize Merv project ${digest(projectId)}\n`;
  return { body, oid: hash('commit', body), repositoryId: `merv:${projectId}` };
}

/** Internal declaration only: callers authorize project creation or work, and so prove the
 * project exists, before calling. */
export async function declareManagedProject(tx: Transaction, projectId: string): Promise<void> {
  if (await tx.get('SELECT project_id FROM code_projects WHERE project_id=?', projectId)) return;
  const root = managedRoot(projectId),
    at = now(),
    operationId = `cop_init_${digest(projectId)}`;
  await tx.run(
    'INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,created_at,phase,progress_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    operationId,
    projectId,
    'system:code',
    'initialize',
    'initialize',
    digest(root),
    canonical(root),
    'prepared',
    at,
    'creating',
    canonical({ target: root.oid }),
    at,
  );
  await tx.run(
    'INSERT INTO code_projects(project_id,mode,repository_id,binding_json,main_json,limits_json,warnings_json,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    projectId,
    'local',
    root.repositoryId,
    canonical({ boundBy: 'system:code', boundAt: at, operationId, managed: true }),
    canonical({ oid: root.oid, admittedBy: 'system:code', admittedAt: at, operationId }),
    '{}',
    '[]',
    at,
  );
}

/** No Git runs inside a transaction; the retained declaration is the recovery queue. */
export async function initializeManagedProjects(
  state: State,
  repositories: CodeRepositories,
  changed: (tx: Transaction, projectId: string) => Promise<void>,
): Promise<void> {
  const pending = await state.read((sql) =>
    sql.all<{ id: string; project_id: string; payload_json: string }>(
      "SELECT id,project_id,payload_json FROM code_operations WHERE kind='initialize' AND status='prepared' ORDER BY created_at,id",
    ),
  );
  for (const row of pending) {
    try {
      await repositories.run(row.project_id, async () => {
        const root = managedRoot(row.project_id);
        check(
          canonical(root) === row.payload_json,
          'code_initialization_changed',
          'The retained repository initialization changed',
          409,
        );
        await repositories.assertRoom(row.project_id, 4096);
        await repositories.ensure(row.project_id, root.repositoryId, 'sha1');
        await repositories.validate(row.project_id, root.repositoryId);
        const env = repositories.environment(row.project_id);
        const storedTree = (
          await repositories.git.ok(['hash-object', '-w', '-t', 'tree', '--stdin'], {
            env,
            input: '',
          })
        )
          .toString()
          .trim();
        const storedCommit = (
          await repositories.git.ok(['hash-object', '-w', '-t', 'commit', '--stdin'], {
            env,
            input: root.body,
          })
        )
          .toString()
          .trim();
        check(
          storedTree === tree && storedCommit === root.oid,
          'code_initialization_changed',
          'Repository root did not match its declaration',
          409,
        );
        const ref = 'refs/merv/initial';
        const current = await repositories.git.run(['rev-parse', '--verify', ref], { env });
        if (current.code === 0)
          check(
            current.stdout.toString().trim() === root.oid,
            'code_initialization_changed',
            'Repository initial ref changed',
            409,
          );
        else await repositories.git.ok(['update-ref', ref, root.oid, '0'.repeat(40)], { env });
        await state.transaction(async (tx) => {
          const live = await tx.get<{ status: string }>(
            'SELECT status FROM code_operations WHERE id=?',
            row.id,
          );
          if (live?.status !== 'prepared') return;
          const project = await tx.get<{ repository_id: string; main_json: string }>(
            'SELECT repository_id,main_json FROM code_projects WHERE project_id=?',
            row.project_id,
          );
          check(
            project?.repository_id === root.repositoryId,
            'code_initialization_changed',
            'Repository identity changed during initialization',
            409,
          );
          const at = now(),
            main = JSON.parse(project.main_json);
          await tx.run(
            'UPDATE code_projects SET store_json=?,updated_at=? WHERE project_id=? AND store_json IS NULL',
            canonical({
              format: 1,
              objectFormat: 'sha1',
              rootOid: root.oid,
              source: 'managed',
              importedBy: 'system:code',
              importedAt: at,
              operationId: row.id,
            }),
            at,
            row.project_id,
          );
          if (main.oid === root.oid && !main.stored)
            await tx.run(
              'UPDATE code_projects SET main_json=?,updated_at=? WHERE project_id=?',
              canonical({ ...main, stored: true }),
              at,
              row.project_id,
            );
          await tx.run(
            "UPDATE code_operations SET status='completed',result_json=?,phase='ready',completed_at=?,updated_at=?,detail_json=NULL,error=NULL WHERE id=? AND status='prepared'",
            canonical({ head: root.oid, tree, receiptRef: ref }),
            at,
            at,
            row.id,
          );
          await changed(tx, row.project_id);
        });
      });
    } catch (error) {
      // Keep the declaration retryable and expose an actionable error; never use scratch.
      await state.transaction((tx) =>
        tx.run(
          "UPDATE code_operations SET detail_json=?,updated_at=? WHERE id=? AND status='prepared'",
          canonical({
            message: error instanceof Error ? error.message : 'Repository initialization failed',
          }),
          now(),
          row.id,
        ),
      );
    }
  }
}
