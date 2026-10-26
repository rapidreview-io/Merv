import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, type Caller } from '@merv/contracts';
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { ProjectScope } from '@merv/scope';
import { ReportService } from '@merv/reports';
import { draftFromPlan } from '@merv/reports/prefill';
import { ReportRenderer } from '@merv/reports/render';
import { openState } from './fixtures/state.js';

test('clear refreshes locked report facts from the current authorized plan and retains history', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'merv-report-rebase-'));
  const state = await openState(dir);
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.credentials.bootstrap({ projectName: 'Reports', actorName: 'Owner' });
  const caller: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(dir, 'blobs'))),
  );
  const reports = await createService(
    new ReportService(state, scope, artifacts, new ReportRenderer()),
  );
  t.after(async () => {
    await reports.close();
    await rm(dir, { recursive: true, force: true });
  });
  let inquiry = 'Old hypothesis';
  let allowed = true;
  reports.registerSubject('experiment', {
    async authorize() {
      assert.ok(allowed, 'subject write denied');
    },
    async prefill() {
      return draftFromPlan({
        id: 'revision-test',
        question: 'Does it work?',
        inquiry,
        constraints: ['No replay'],
      });
    },
  });
  const subject = { subjectKind: 'experiment', subjectId: 'experiment-test' };
  const first = await reports.open(caller, subject);
  inquiry = 'Untested revised hypothesis';
  // Merely opening must not discard an existing draft. Ordinary edits still cannot change locks.
  assert.equal((await reports.open(caller, subject)).source, first.source);
  await assert.rejects(
    reports.write(caller, {
      ...subject,
      expectedRevision: 1,
      requestId: 'edit-locked',
      sections: [{ name: 'Inquiry', content: inquiry }],
    }),
    { code: 'report_locked_section' },
  );
  const command = { ...subject, expectedRevision: 1, requestId: 'clear-current-plan' };
  allowed = false;
  await assert.rejects(reports.clear(caller, command), /subject write denied/);
  allowed = true;
  const rebased = await reports.clear(caller, command);
  assert.equal(rebased.revision, 2);
  assert.match(rebased.source, /Untested revised hypothesis/);
  assert.doesNotMatch(rebased.source, /Old hypothesis/);
  assert.deepEqual(await reports.clear(caller, command), rebased);
  await assert.rejects(
    reports.write(caller, {
      ...subject,
      expectedRevision: 2,
      requestId: 'edit-new-lock',
      sections: [{ name: 'Inquiry', content: 'Unsupported success' }],
    }),
    { code: 'report_locked_section' },
  );
  const history = await state.read((tx) =>
    tx.all<{ record: string }>(
      'SELECT record FROM report_revisions WHERE report_id=? ORDER BY revision',
      first.reportId,
    ),
  );
  assert.equal(history.length, 2);
  assert.equal(JSON.parse(history[0].record).source, first.source);
  assert.equal(JSON.parse(history[1].record).base, rebased.source);
});
