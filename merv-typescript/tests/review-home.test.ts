import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Caller } from '@merv/contracts';
import { currentReview } from '@merv/reviews/rules';
import { createApp } from './fixtures/app.js';

/**
 * What Home and the rail poll of Reviews does not grow with every round a project ever ran:
 * the open reviews, each subject's current review and newest verdict, and the newest verdicts.
 */
test('Home reads open reviews, each subject’s current one and the newest verdicts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-review-home-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  );
  config.plugins = config.plugins.filter(
    (entry: { id: string }) =>
      !['api', 'identity', 'ui'].includes(entry.id) &&
      !entry.id.endsWith('-api') &&
      !entry.id.endsWith('-ui'),
  );
  const app = await createApp({ directory, config });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Review home',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  // One subject reviewed round after round, then open again; 30 others reviewed once.
  const rows: [string, string, number, string, string | null, string][] = [];
  let minute = 0;
  const at = () => new Date(Date.UTC(2026, 9, 1, 0, minute++)).toISOString();
  for (let round = 0; round < 12; round++)
    rows.push([`r-main-${round}`, 'main', round, 'submitted', 'needs_changes', at()]);
  rows.push(['r-main-open', 'main', 12, 'requested', null, at()]);
  for (let index = 0; index < 30; index++)
    rows.push([`r-other-${index}`, `other-${index}`, 0, 'submitted', 'pass', at()]);
  await app.ctx.state.transaction(async (tx) => {
    for (const [id, subject, revision, status, verdict, created] of rows)
      await tx.run(
        `INSERT INTO reviews(id,project_id,subject_id,subject_revision,producer_id,artifact_ids,criteria,manifest,snapshot_hash,status,reviewer_id,verdict,created_at,excluded_actor_ids)
          VALUES(?,?,?,?,'producer','[]','[]','{}','hash',?,?,?,?,'[]')`,
        id,
        owner.projectId,
        subject,
        revision,
        status,
        status === 'submitted' ? 'reviewer' : null,
        verdict,
        created,
      );
  });
  const listed = await app.ctx.reviews.list(owner);
  const home = await app.ctx.reviews.home(owner);
  assert.equal(listed.length, 43);
  // The open one, the subject's newest verdict, and every other subject's single review.
  assert.deepEqual(
    home.map((review) => review.id).sort(),
    [
      'r-main-11',
      'r-main-open',
      ...Array.from({ length: 30 }, (_, index) => `r-other-${index}`),
    ].sort(),
  );
  // What the pages derive from it is what they derived from every review.
  for (const subject of ['main', 'other-3'])
    assert.deepEqual(currentReview(home, subject), currentReview(listed, subject));
  const flags = (reviews: typeof listed) =>
    reviews.map(({ id, open, returned }) => ({ id, open, returned }));
  assert.deepEqual(
    flags(home),
    flags(listed).filter((review) => home.some((kept) => kept.id === review.id)),
  );
});
