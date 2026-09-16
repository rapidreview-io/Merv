import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_TRANSFER_BYTES } from '@merv/blobs';
import { check, digest, now, type Blobs, type State, type Transaction } from '@merv/contracts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const row = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const snapshotSchema = row({
  sourceId: id,
  schemaVersion: z.literal(81),
  issuer: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/auth/v1'
      );
    }),
  projects: z.array(
    row({
      id,
      name: z.string().min(1),
      summary: z.string(),
      created_at: timestamp,
      status: z.literal('active'),
    }),
  ),
  memberships: z.array(row({ project_id: id, user_id: id, added_at: timestamp })),
  artifacts: z.array(
    row({
      id,
      project_id: id,
      title: z.string(),
      path: z.string(),
      created_by: z.string(),
      created_at: timestamp,
      status: z.literal('complete'),
      content_type: z.string().min(1),
      content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      size_bytes: z.number().int().nonnegative(),
    }),
  ),
  claims: z.array(
    row({
      id,
      project_id: id,
      statement: z.string().min(1),
      scope: z.string(),
      status: z.enum(['draft', 'active', 'supported', 'weakened', 'contradicted', 'abandoned']),
      confidence: z.enum(['low', 'medium', 'high']),
      created_at: timestamp,
    }),
  ),
});

export type LegacyFoundationSnapshot = z.infer<typeof snapshotSchema>;
export interface LegacyFoundationReceipt {
  sourceId: string;
  fingerprint: string;
  importedAt: string;
  projects: number;
  memberships: number;
  artifacts: number;
  claims: number;
  researchHistoryImported: false;
  credentialsImported: false;
}

/** A foundation rehearsal is deliberately not a declaration of completed migration. */
export function planLegacyFoundation(input: unknown) {
  const result = snapshotSchema.safeParse(input);
  check(result.success, 'invalid_legacy_snapshot', 'Legacy foundation snapshot is invalid');
  const snapshot = result.data;
  const unique = (values: string[], label: string) =>
    check(
      new Set(values).size === values.length,
      'invalid_legacy_snapshot',
      `Duplicate ${label} in legacy snapshot`,
    );
  unique(
    snapshot.projects.map((p) => p.id),
    'project',
  );
  unique(
    snapshot.memberships.map((m) => `${m.project_id}/${m.user_id}`),
    'membership',
  );
  unique(
    snapshot.artifacts.map((a) => a.id),
    'artifact',
  );
  unique(
    snapshot.claims.map((c) => c.id),
    'claim',
  );
  const projects = new Set(snapshot.projects.map((p) => p.id));
  for (const record of [...snapshot.memberships, ...snapshot.artifacts, ...snapshot.claims])
    check(
      projects.has(record.project_id),
      'invalid_legacy_snapshot',
      'A record references a missing project',
    );
  for (const project of snapshot.projects)
    check(
      snapshot.memberships.some((m) => m.project_id === project.id),
      'invalid_legacy_snapshot',
      'An imported project has no source membership',
    );
  const sizes = new Map<string, number>();
  for (const artifact of snapshot.artifacts) {
    const key = `${artifact.project_id}/${artifact.content_sha256}`;
    check(
      !sizes.has(key) || sizes.get(key) === artifact.size_bytes,
      'invalid_legacy_snapshot',
      'Identical artifact hashes have conflicting sizes',
    );
    sizes.set(key, artifact.size_bytes);
  }
  snapshot.projects.sort((a, b) => a.id.localeCompare(b.id));
  snapshot.memberships.sort((a, b) =>
    `${a.project_id}/${a.user_id}`.localeCompare(`${b.project_id}/${b.user_id}`),
  );
  snapshot.artifacts.sort((a, b) => a.id.localeCompare(b.id));
  snapshot.claims.sort((a, b) => a.id.localeCompare(b.id));
  return {
    snapshot,
    fingerprint: digest(snapshot),
    projects: snapshot.projects.length,
    memberships: snapshot.memberships.length,
    artifacts: snapshot.artifacts.length,
    claims: snapshot.claims.length,
    distinctBlobs: sizes.size,
    oversizedArtifacts: snapshot.artifacts.filter((a) => a.size_bytes > 2_000_000).map((a) => a.id),
    researchHistoryImported: false as const,
    credentialsImported: false as const,
  };
}

const table = `CREATE TABLE legacy_foundation_imports (
  source_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL
);`;
async function initialize(state: State) {
  await state.migrate('legacy-foundation-import', [
    {
      version: 1,
      sql: `${table}
CREATE TRIGGER legacy_foundation_no_update BEFORE UPDATE ON legacy_foundation_imports
 BEGIN SELECT RAISE(ABORT,'Import receipts are immutable'); END;
CREATE TRIGGER legacy_foundation_no_delete BEFORE DELETE ON legacy_foundation_imports
 BEGIN SELECT RAISE(ABORT,'Import receipts are retained'); END;`,
      postgres: `${table}
CREATE FUNCTION legacy_foundation_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN RAISE EXCEPTION USING MESSAGE='Import receipts are immutable', ERRCODE='23514'; END;
$merv$;
CREATE TRIGGER legacy_foundation_no_update BEFORE UPDATE OR DELETE ON legacy_foundation_imports
FOR EACH ROW EXECUTE FUNCTION legacy_foundation_immutable_guard();`,
    },
  ]);
}

function replay(
  previous: { fingerprint: string; receipt: string } | undefined,
  fingerprint: string,
) {
  if (!previous) return undefined;
  check(
    previous.fingerprint === fingerprint,
    'legacy_import_conflict',
    'This source ID already identifies different imported content',
    409,
  );
  return JSON.parse(previous.receipt) as LegacyFoundationReceipt;
}
const memberId = (prefix: string, projectId: string, issuer: string, subject: string) =>
  `${prefix}_${digest({ projectId, issuer, subject }).slice(0, 32)}`;

/**
 * Trusted, offline foundation import. Initialize Scope/Artifacts/Claims first and use an empty
 * isolated target. This imports no workflow history, credentials or active assignments.
 * Every source/destination byte operation finishes before the metadata writer opens.
 */
export async function importLegacyFoundation(
  services: {
    state: State;
    sourceBlobs: Pick<Blobs, 'get'>;
    destinationBlobs: Pick<Blobs, 'put' | 'get'>;
    /** Trusted offline adapter only. Must verify source/destination size and streaming SHA-256
     * before resolving; use S3Blobs.copyVerifiedFrom. Runs serially outside the metadata writer. */
    copyArtifact?: (
      projectId: string,
      hash: string,
      size: number,
    ) => Promise<{ hash: string; size: number }>;
  },
  input: unknown,
): Promise<LegacyFoundationReceipt> {
  const plan = planLegacyFoundation(input);
  check(
    !plan.oversizedArtifacts.length || !!services.copyArtifact,
    'legacy_large_artifacts_unsupported',
    `${plan.oversizedArtifacts.length} artifacts require the legacy large-download migration path`,
  );
  check(
    plan.snapshot.artifacts.every((artifact) => artifact.size_bytes <= MAX_TRANSFER_BYTES),
    'legacy_large_artifacts_unsupported',
    'An artifact exceeds the bounded 512 MiB transfer limit',
  );
  const { state, sourceBlobs, destinationBlobs } = services;
  const { snapshot, fingerprint } = plan;
  await initialize(state);
  const previous = await state.read((sql) =>
    sql.get<{ fingerprint: string; receipt: string }>(
      'SELECT fingerprint,receipt FROM legacy_foundation_imports WHERE source_id=?',
      snapshot.sourceId,
    ),
  );
  const existing = replay(previous, fingerprint);
  if (existing) return existing;
  const empty = async (tx: Pick<Transaction, 'get'>) =>
    check(
      !(await tx.get('SELECT id FROM projects LIMIT 1')),
      'legacy_target_not_empty',
      'First import requires an empty isolated target',
      409,
    );
  await state.read(empty);

  const copied = new Set<string>();
  for (const artifact of snapshot.artifacts) {
    const key = `${artifact.project_id}/${artifact.content_sha256}`;
    if (copied.has(key)) continue;
    if (services.copyArtifact) {
      const verified = await services.copyArtifact(
        artifact.project_id,
        artifact.content_sha256,
        artifact.size_bytes,
      );
      check(
        verified.hash === artifact.content_sha256 && verified.size === artifact.size_bytes,
        'legacy_blob_mismatch',
        'Verified transfer receipt does not match retained metadata',
      );
      copied.add(key);
      continue;
    }
    const bytes = await sourceBlobs.get(artifact.project_id, artifact.content_sha256);
    check(
      bytes.length === artifact.size_bytes &&
        createHash('sha256').update(bytes).digest('hex') === artifact.content_sha256,
      'legacy_blob_mismatch',
      'Source artifact bytes do not match retained metadata',
    );
    const stored = await destinationBlobs.put(artifact.project_id, bytes);
    check(
      stored.hash === artifact.content_sha256 && stored.size === artifact.size_bytes,
      'legacy_blob_mismatch',
      'Destination artifact receipt does not match retained metadata',
    );
    const verified = await destinationBlobs.get(artifact.project_id, artifact.content_sha256);
    check(
      verified.length === artifact.size_bytes &&
        createHash('sha256').update(verified).digest('hex') === artifact.content_sha256,
      'legacy_blob_mismatch',
      'Destination artifact bytes do not match retained metadata',
    );
    copied.add(key);
  }

  return state.transaction(async (tx) => {
    const previous = replay(
      await tx.get<{ fingerprint: string; receipt: string }>(
        'SELECT fingerprint,receipt FROM legacy_foundation_imports WHERE source_id=?',
        snapshot.sourceId,
      ),
      fingerprint,
    );
    if (previous) return previous;
    await empty(tx);
    for (const project of snapshot.projects)
      await tx.run(
        'INSERT INTO projects(id,name,summary,created_at) VALUES(?,?,?,?)',
        project.id,
        project.name,
        project.summary,
        project.created_at,
      );
    for (const member of snapshot.memberships) {
      const actor = memberId('actor', member.project_id, snapshot.issuer, member.user_id);
      await tx.run(
        'INSERT INTO shared_users(issuer,subject,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',
        snapshot.issuer,
        member.user_id,
        member.added_at,
      );
      await tx.run(
        'INSERT INTO actors(id,project_id,name,role,active) VALUES(?,?,?,?,1)',
        actor,
        member.project_id,
        `Member ${member.user_id}`,
        'operator',
      );
      await tx.run(
        'INSERT INTO member_actors(project_id,issuer,subject,actor_id) VALUES(?,?,?,?)',
        member.project_id,
        snapshot.issuer,
        member.user_id,
        actor,
      );
      await tx.run(
        'INSERT INTO project_memberships(id,project_id,issuer,subject,actor_id,role,active,created_at,revoked_at) VALUES(?,?,?,?,?,?,1,?,NULL)',
        memberId('membership', member.project_id, snapshot.issuer, member.user_id),
        member.project_id,
        snapshot.issuer,
        member.user_id,
        actor,
        'operator',
        member.added_at,
      );
    }
    for (const artifact of snapshot.artifacts)
      await tx.run(
        'INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at) VALUES(?,?,?,?,?,?,?,?)',
        artifact.id,
        artifact.project_id,
        artifact.created_by,
        artifact.title || artifact.path || artifact.id,
        artifact.content_type,
        artifact.content_sha256,
        artifact.size_bytes,
        artifact.created_at,
      );
    for (const claim of snapshot.claims)
      await tx.run(
        'INSERT INTO claims(id,project_id,statement,scope,status,confidence,revision,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?,?,?)',
        claim.id,
        claim.project_id,
        claim.statement,
        claim.scope,
        claim.status,
        claim.confidence,
        'system:legacy-import',
        'system:legacy-import',
        claim.created_at,
        claim.created_at,
      );
    const receipt: LegacyFoundationReceipt = {
      sourceId: snapshot.sourceId,
      fingerprint,
      importedAt: now(),
      projects: plan.projects,
      memberships: plan.memberships,
      artifacts: plan.artifacts,
      claims: plan.claims,
      researchHistoryImported: false,
      credentialsImported: false,
    };
    await tx.run(
      'INSERT INTO legacy_foundation_imports(source_id,fingerprint,receipt) VALUES(?,?,?)',
      snapshot.sourceId,
      fingerprint,
      JSON.stringify(receipt),
    );
    return receipt;
  });
}
