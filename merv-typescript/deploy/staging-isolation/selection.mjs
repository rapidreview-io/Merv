/** Read-only staging ledger census. Exact resource/reference IDs, including duplicate file refs,
 * are retained; denominator counts are assertions, never substitutes for set equality.
 */
import pg from 'pg';
import { durable, need, hash } from './history.mjs';
export async function selection(main, source) {
  await main.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    need(
      (await main.query('SELECT current_database() AS name')).rows[0].name === 'postgres',
      'unexpected Merv database',
    );
    const allocations = (
      await main.query(
        'SELECT id,phase,data_json::jsonb AS data FROM merv_ts_staging.fleet_allocations ORDER BY id',
      )
    ).rows;
    need(
      allocations.length === 75 && allocations.every((a) => a.phase === 'released'),
      'expected exact 75 released allocations',
    );
    const sandboxIds = allocations.map((a) => a.data.runtime?.sandboxId);
    need(
      sandboxIds.every((x) => typeof x === 'string') && new Set(sandboxIds).size === 75,
      'allocation sandbox IDs are not exact',
    );
    const native = (
      await source.query(
        'SELECT id,namespace,state FROM public.sandboxes WHERE provider=ANY($1) ORDER BY id',
        [['cloudflare-fleet-staging', 'cloudflare-fleet-staging-large']],
      )
    ).rows;
    need(
      hash(native.map((r) => r.id).sort()) === hash([...sandboxIds].sort()) &&
        native.every((r) => r.state === 'stopped'),
      'source and Fleet ID sets differ',
    );
    const work = (
      await main.query(
        'SELECT to_jsonb(w) AS row FROM merv_ts_staging.sandbox_native_work w ORDER BY namespace',
      )
    ).rows.map((r) => r.row);
    const captures = (
      await main.query(
        'SELECT to_jsonb(c) AS row FROM merv_ts_staging.sandbox_native_captures c ORDER BY namespace,workflow_id,node_id',
      )
    ).rows.map((r) => r.row);
    const connections = (
      await main.query(
        'SELECT id,project_id,root_id,account_id,member_id,connected_at,revoked_at FROM merv_ts_staging.sandbox_native_connections ORDER BY id',
      )
    ).rows;
    need(
      work.length === 14 &&
        work.every((w) => w.closed_at && w.namespace) &&
        captures.length === 6 &&
        connections.length === 1,
      'historical ledger cohort drift',
    );
    const artifacts = (
      await main.query(
        `SELECT id,project_id,file_refs_json AS refs,files_json AS files
         FROM merv_ts_staging.artifacts
         WHERE file_refs_json @> '[{"provider":"sandboxes"}]'::jsonb
            OR file_refs_json @> '[{"provider":"sandboxes-native"}]'::jsonb
         ORDER BY id`,
      )
    ).rows;
    const refs = [],
      roots = sandboxIds.map((id) => ({ table: 'sandboxes', key: { id } }));
    const namespaces = new Set([
      ...native.map((n) => n.namespace),
      ...work.map((w) => w.namespace),
      ...captures.map((c) => c.namespace),
    ]);
    for (const artifact of artifacts)
      for (const [position, ref] of artifact.refs.entries()) {
        if (!['sandboxes', 'sandboxes-native'].includes(ref.provider)) continue;
        let namespace, objectId, digest, size, connectionId;
        if (ref.provider === 'sandboxes-native') {
          const v = JSON.parse(ref.reference);
          need(v.length === 10 && v[0] === 1, 'unknown native artifact reference');
          [, connectionId, namespace, , , , , objectId, digest, size] = v;
          need(
            connections.some((c) => c.id === connectionId && c.project_id === artifact.project_id),
            'artifact connection belongs to another project',
          );
        } else {
          namespace = 'merv-ml';
          objectId = ref.reference;
          const file = artifact.files.filter(
            (f) => f.name === ref.name && f.provider === ref.provider,
          );
          need(file.length === 1, 'ambiguous bare capture identity');
          digest = file[0].hash;
          size = file[0].size;
        }
        need(
          typeof objectId === 'string' &&
            /^[a-f0-9]{64}$/.test(digest) &&
            Number.isSafeInteger(size) &&
            size >= 0,
          'invalid artifact identity',
        );
        const object = (
          await source.query(
            'SELECT namespace,sha256,size_bytes::float8 AS size,state FROM public.storage_objects WHERE id=$1',
            [objectId],
          )
        ).rows[0];
        need(
          object &&
            object.namespace === namespace &&
            object.sha256 === digest &&
            object.size === size &&
            object.state === 'available',
          'artifact source identity mismatch',
        );
        refs.push({
          referenceKey: `${artifact.id}:${position}:${ref.name}`,
          artifact: artifact.id,
          project: artifact.project_id,
          reference: ref,
          namespace,
          objectId,
          sha256: digest,
          size,
        });
        namespaces.add(namespace);
        roots.push({ table: 'storage_objects', key: { id: objectId } });
      }
    need(
      refs.filter((r) => r.reference.provider === 'sandboxes-native').length === 15,
      'expected all 15 native file references',
    );
    for (const namespace of namespaces)
      roots.push({ table: 'infra_namespaces', key: { name: namespace } });
    // These closed work namespaces are separately attested in Merv. Never expand the shared Pi/ML namespace.
    for (const table of ['sandboxes', 'pipelines', 'snapshots', 'storage_objects']) {
      const rows = (
        await source.query(
          `SELECT id FROM public.${table} WHERE namespace=ANY($1::text[]) ORDER BY id`,
          [work.map((w) => w.namespace)],
        )
      ).rows;
      for (const { id } of rows) roots.push({ table, key: { id } });
    }
    return {
      version: 1,
      namespaces: [...namespaces].sort(),
      roots,
      provenance: { allocations, work, captures, connections, refs },
      ledgerSha256: hash({ allocations, work, captures, connections, refs }),
    };
  } finally {
    await main.query('ROLLBACK');
    await source.query('ROLLBACK');
  }
}
if (process.argv[1]?.endsWith('/selection.mjs')) {
  const main = new pg.Client({ connectionString: process.env.STAGING_MERV_DATABASE_URL }),
    source = new pg.Client({ connectionString: process.env.STAGING_HISTORY_DATABASE_URL });
  try {
    await main.connect();
    await source.connect();
    durable(process.argv[2], await selection(main, source));
  } catch {
    console.error(
      'Historical selection refused: cohort, project ownership or exact reference identity changed.',
    );
    process.exitCode = 1;
  } finally {
    await main.end();
    await source.end();
  }
}
