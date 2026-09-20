import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = '/private/tmp/merv-deepseek-acceptance-20260918';
const runs = ['user-keys-v2', 'dispatch-v2', 'dispatch-replication', 'experiments-git-v2', 'review-returns'];
const result = { auditedAt: new Date().toISOString(), runs: [] };
for (const run of runs) {
  const base = join(root, run, run.startsWith('experiments') || run === 'review-returns' ? 'server' : 'data');
  if (!existsSync(join(base, 'state.sqlite'))) continue;
  const db = new DatabaseSync(join(base, 'state.sqlite'), { readOnly: true });
  const artifacts = db.prepare('SELECT id,project_id,hash,size,media_type FROM artifacts').all();
  const verifiedArtifacts = [];
  let calculation;
  for (const artifact of artifacts) {
    const bytes = readFileSync(join(base, 'blobs', artifact.project_id, artifact.hash.slice(0, 2), artifact.hash));
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, artifact.hash, `${run}: artifact hash mismatch`);
    assert.equal(bytes.length, artifact.size, `${run}: artifact size mismatch`);
    verifiedArtifacts.push({ id: artifact.id, sha256: digest, bytes: bytes.length });
    let data;
    try { data = JSON.parse(bytes.toString('utf8')); } catch { continue; }
    if (run === 'experiments-git-v2' && data.train?.x && data.candidate?.predictions && data.code) {
      assert.deepEqual(data.train, { x: [-3, -2, -1], y: [-5, -3, -1] });
      assert.deepEqual(data.test, { x: [0, 1, 2, 3, 4], y: [1, 3, 5, 7, 9] });
      const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
      const mx = mean(data.train.x), my = mean(data.train.y);
      const slope = data.train.x.reduce((sum, x, i) => sum + (x - mx) * (data.train.y[i] - my), 0) /
        data.train.x.reduce((sum, x) => sum + (x - mx) ** 2, 0);
      const intercept = my - slope * mx;
      const baseline = data.test.x.map(() => my);
      const candidate = data.test.x.map(x => slope * x + intercept);
      const errors = predictions => predictions.map((value, i) => Math.abs(value - data.test.y[i]));
      assert.equal(data.candidate.slope, slope);
      assert.equal(data.candidate.intercept, intercept);
      assert.deepEqual(data.baseline.predictions, baseline);
      assert.deepEqual(data.candidate.predictions, candidate);
      assert.deepEqual(data.baseline.absoluteErrors, errors(baseline));
      assert.deepEqual(data.candidate.absoluteErrors, errors(candidate));
      assert.equal(data.baseline.mae, mean(errors(baseline)));
      assert.equal(data.candidate.mae, mean(errors(candidate)));
      assert.equal(data.denominator, data.test.y.length);
      assert.equal(data.criterion.met, mean(errors(candidate)) < mean(errors(baseline)));
      calculation = { artifactId: artifact.id, trainingCount: 3, heldOutCount: 5, slope, intercept,
        baselineMae: mean(errors(baseline)), candidateMae: mean(errors(candidate)), independentlyRecomputed: true };
    }
  }
  const reviews = db.prepare('SELECT id,subject_id,subject_revision,status,producer_id,reviewer_id,verdict,return_to,artifact_ids FROM reviews').all();
  for (const review of reviews.filter(row => row.status === 'submitted')) {
    assert.notEqual(review.producer_id, review.reviewer_id, `${run}: self-review`);
    for (const id of JSON.parse(review.artifact_ids)) assert.ok(verifiedArtifacts.some(artifact => artifact.id === id));
  }
  const workflows = db.prepare('SELECT id,workflow,state,revision FROM wf_instances ORDER BY id').all();
  const starts = db.prepare('SELECT instance_id,revision,actor_id FROM wf_work_starts ORDER BY instance_id,revision').all();
  const sessions = db.prepare('SELECT id,instance_id,revision,actor_id,status FROM worker_sessions ORDER BY revision').all();
  const calls = db.prepare('SELECT tool,status,count(*) AS count FROM session_tool_calls GROUP BY tool,status').all();
  result.runs.push({ run, workflows, reviews, starts, sessions, calls, verifiedArtifacts, ...(calculation ? { calculation } : {}) });
  db.close();
}
writeFileSync(join(root, 'independent-audit.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(result.runs.map(run => ({ run: run.run, workflows: run.workflows.map(w => w.state),
  artifactHashesVerified: run.verifiedArtifacts.length, submittedReviews: run.reviews.filter(r => r.status === 'submitted').length,
  calculation: run.calculation })), null, 2));
