import { createHash } from 'node:crypto';
import type { Blobs, Sql, State } from '@merv/contracts';

/**
 * One-time retirement of the research claims archive. Each claim becomes a Markdown artifact
 * that keeps the claim's author, creation time and edit history; then the claims tables are
 * dropped in the same transaction. Claim events stay in the immutable event log. A database
 * without a claims table has nothing to do. Delete this module once every deployed database
 * has run it.
 */
interface ClaimRow {
  id: string;
  project_id: string;
  statement: string;
  scope: string;
  status: string;
  confidence: string;
  revision: number | string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}
interface ClaimEvent {
  project_id: string;
  subject_id: string;
  actor_id: string;
  type: string;
  data_json: string;
  created_at: string;
}

/** Deterministic, and shaped like `newId('art')` so every artifact link and name lookup finds it. */
export const claimArtifactId = (projectId: string, claimId: string) =>
  `art_${createHash('sha256').update(`${projectId}\n${claimId}`).digest('hex').slice(0, 32)}`;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function claimTitle(claim: Pick<ClaimRow, 'id' | 'statement'>): string {
  const title = `Claim: ${oneLine(claim.statement) || claim.id}`;
  if (title.length <= 300) return title;
  // Artifact titles are limited in UTF-16 units; never cut a surrogate pair in half.
  const cut = title.slice(0, 299);
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

export function claimMarkdown(claim: ClaimRow, history: ClaimEvent[]): string {
  const quote = (text: string) =>
    text
      .trim()
      .split('\n')
      .map((line) => `> ${line}`.trimEnd())
      .join('\n');
  // The legacy import wrote placeholder revision and authorship; say so instead of presenting it.
  const imported = claim.created_by === 'system:legacy-import';
  const lines = [
    '# Archived research claim',
    '',
    quote(claim.statement || '(no statement)'),
    '',
    `- **Status:** ${claim.status}`,
    `- **Confidence:** ${claim.confidence}`,
    `- **Scope:** ${oneLine(claim.scope) || '(none)'}`,
    ...(imported
      ? [
          `- **Created:** ${claim.created_at}, imported from the previous system at the 2026-09-16 cutover; its author, revisions and edit history were not imported (see the legacy history archive)`,
        ]
      : [
          `- **Revision:** ${Number(claim.revision)}`,
          `- **Created:** ${claim.created_at} by ${claim.created_by}`,
          `- **Last updated:** ${claim.updated_at} by ${claim.updated_by}`,
        ]),
    `- **Original claim ID:** \`${claim.id}\``,
  ];
  if (history.length) {
    lines.push('', '## History', '');
    let statement: string | undefined;
    for (const event of history) {
      const data = JSON.parse(event.data_json) as Record<string, unknown>;
      const change = event.type === 'claim.created' ? 'created' : 'updated';
      lines.push(
        `- ${event.created_at}: ${change} by ${event.actor_id} (revision ${String(data.revision ?? '?')}, ${String(data.status ?? '?')}, ${String(data.confidence ?? '?')} confidence)`,
      );
      if (typeof data.statement === 'string' && data.statement !== statement) {
        if (statement !== undefined) lines.push(`  - Statement: ${oneLine(data.statement)}`);
        statement = data.statement;
      }
    }
  }
  lines.push(
    '',
    'Converted to a file when the claims feature was retired; the living paper now holds hypotheses and conclusions.',
    '',
    'The stored claim record, exactly as it was:',
    '',
    '```json',
    JSON.stringify(claim, null, 2),
    '```',
    '',
  );
  return lines.join('\n');
}

const claimsTable = async (sql: Sql) =>
  sql.dialect === 'postgres'
    ? Boolean(
        (await sql.get<{ name: string | null }>("SELECT to_regclass('claims') AS name"))?.name,
      )
    : Boolean(
        await sql.get("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='claims'"),
      );

export async function retireClaims(state: State, blobs: Blobs): Promise<number> {
  if (!(await state.read(claimsTable))) return 0;
  let claims: ClaimRow[];
  let events: ClaimEvent[];
  try {
    [claims, events] = await state.read(async (sql) => [
      await sql.all<ClaimRow>('SELECT * FROM claims ORDER BY project_id,created_at,id'),
      await sql.all<ClaimEvent>(
        "SELECT project_id,subject_id,actor_id,type,data_json,created_at FROM events WHERE type IN ('claim.created','claim.updated') ORDER BY id",
      ),
    ]);
  } catch (error) {
    // Another server dropped the table between the check and this read: it did the work.
    if (!(await state.read(claimsTable))) return 0;
    throw error;
  }
  // Bytes go to storage before the metadata transaction; a rerun after a failure writes the
  // same content-addressed objects again, so nothing here depends on the first attempt.
  const files: { claim: ClaimRow; hash: string; size: number }[] = [];
  for (const claim of claims) {
    const history = events.filter(
      (event) => event.project_id === claim.project_id && event.subject_id === claim.id,
    );
    const stored = await blobs.put(
      claim.project_id,
      Buffer.from(claimMarkdown(claim, history), 'utf8'),
    );
    files.push({ claim, ...stored });
  }
  return await state.transaction(async (tx) => {
    // Writers are serialised, so another server that finished first leaves nothing to do here;
    // the read above covers a server that is still dropping the tables.
    if (!(await claimsTable(tx))) return 0;
    const count = await tx.get<{ count: number | string }>('SELECT COUNT(*) AS count FROM claims');
    if (Number(count?.count) !== files.length) throw new Error('Claims changed during retirement');
    for (const { claim, hash, size } of files)
      await tx.run(
        'INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
        claimArtifactId(claim.project_id, claim.id),
        claim.project_id,
        claim.created_by,
        claimTitle(claim),
        'text/markdown',
        hash,
        size,
        claim.created_at,
      );
    await tx.run('DROP TABLE claim_commands');
    await tx.run('DROP TABLE claims');
    if (tx.dialect === 'postgres')
      await tx.run(
        'DROP FUNCTION claims_identity_immutable_guard(), claims_no_delete_guard(), claim_commands_no_update_guard(), claim_commands_no_delete_guard()',
      );
    await tx.run("DELETE FROM component_migrations WHERE component='claims'");
    return files.length;
  });
}
