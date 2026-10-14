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
 * every open review, however old, and the 200 newest settled ones.
 */
test('Home reads every open review and the 200 newest settled ones', async (t) => {
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
  // Two reviews open since before everything else; one subject returned twice and open again;
  // 205 others settled once, every 40th superseded rather than decided.
  const rows: [string, string, number, string, string | null, string][] = [];
  let minute = 0;
  const at = () => new Date(Date.UTC(2026, 9, 1, 0, minute++)).toISOString();
  rows.push(['r-waiting', 'waiting', 0, 'requested', null, at()]);
  rows.push(['r-claimed', 'claimed', 0, 'started', null, at()]);
  rows.push(['r-main-0', 'main', 0, 'submitted', 'needs_changes', at()]);
  for (let index = 0; index < 205; index++) {
    const superseded = index % 40 === 39;
    rows.push([
      `r-other-${index}`,
      `other-${index}`,
      0,
      superseded ? 'superseded' : 'submitted',
      superseded ? null : 'pass',
      at(),
    ]);
    if (index === 100) rows.push(['r-main-1', 'main', 1, 'submitted', 'needs_changes', at()]);
  }
  rows.push(['r-main-open', 'main', 2, 'requested', null, at()]);
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
        ['submitted', 'started'].includes(status) ? 'reviewer' : null,
        verdict,
        created,
      );
  });
  const listed = await app.ctx.reviews.list(owner);
  const home = await app.ctx.reviews.home(owner);
  const open = ['r-waiting', 'r-claimed', 'r-main-open'];
  const settled = rows.map(([id]) => id).filter((id) => !open.includes(id));
  assert.equal(listed.length, 210);
  // Every open one, however old, and exactly the 200 newest settled: r-main-0 and the six
  // oldest others are left out.
  assert.deepEqual(
    home.map((review) => review.id).sort(),
    [...open, ...settled.slice(-200)].sort(),
  );
  // What the pages derive from it is what they derived from every review, in the same order.
  for (const subject of ['main', 'other-199', 'other-204'])
    assert.deepEqual(currentReview(home, subject), currentReview(listed, subject));
  const flags = (reviews: typeof listed) =>
    reviews.map(({ id, open, returned }) => ({ id, open, returned }));
  assert.deepEqual(
    flags(home),
    flags(listed).filter((review) => home.some((kept) => kept.id === review.id)),
  );
});
