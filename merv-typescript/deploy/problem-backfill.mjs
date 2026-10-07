#!/usr/bin/env node
// One-off: copy each project's old Scope summary into its Paper Problem, as a draft revision,
// where the project has no Problem yet. Nothing reads projects.summary any more; scope@10 drops
// it, and refuses to run while any project still holds a summary and no Problem.
//
// Release order (the owner's, 2026-10-07):
//   (a) back up production;
//   (b) run this script in production, first with --dry-run, then without;
//   (c) release Main with scope@10, which drops the summary.
//
// Run inside Main's container, with the modules of the release it is running, from
// `merv-typescript`:
//
//   ssh -o BatchMode=yes ResearchSuite_Control 'sudo docker exec -i -e MERV_PROBLEM_BACKFILL=1 -w /app merv-typescript-control-1 node --input-type=module - --dry-run' < deploy/problem-backfill.mjs
//
// and again without `--dry-run` to write. A dry run makes every write in a transaction that it
// then rolls back, so Paper checks each Problem as it would keep it. It prints one JSON line per
// project (its id, the summary's length and where each part of it goes, never its text) and a
// last line of totals. The write is idempotent: a project that has a Problem is skipped, and
// each project's Paper command carries one fixed request id.
//
// The Problem is written through Paper's own service, as the project's operator (its
// longest-standing signed-in operator, as Scope names it) or, for a project with none, as Scope's
// service actor for Paper. Only the summaries themselves are read with SQL: Scope no longer has
// an API for them.
import { PROBLEM_SECTIONS } from '@merv/paper/rules';
import { sourceCaller } from '@merv/scope/rules';

/** The fixed request id of each project's Paper command, so a rerun replays rather than adds. */
export const REQUEST_ID = 'problem-from-summary-2026-10';
/** Headings that name a Problem section, by their normalised text. */
const HEADINGS = new Map([
  ['problem', 'problem'],
  ['problems', 'problem'],
  ['problem statement', 'problem'],
  ['the problem', 'problem'],
  ['scope', 'scope'],
  ['goal', 'goals'],
  ['goals', 'goals'],
  ['constraint', 'constraints'],
  ['constraints', 'constraints'],
]);
const normal = (text) =>
  text
    .replace(/[*_`]/g, '')
    .replace(/[:.]+$/, '')
    .trim()
    .toLowerCase();

/**
 * A summary as the Problem's four sections. A heading naming a section (Problem, Scope, Goals,
 * Constraints) starts it, and its line is dropped: Paper titles each section itself. Deeper
 * headings stay inside the section they follow. Everything else (text before the first heading,
 * and any other heading with what follows it) goes into the first section, Problem, with that
 * heading kept at level 3 or deeper so it nests under the section's own.
 */
export function problemFromSummary(summary) {
  const parts = Object.fromEntries(PROBLEM_SECTIONS.map((id) => [id, []]));
  const mapping = [];
  let current = { heading: '(text before any heading)', to: PROBLEM_SECTIONS[0], level: 0 };
  let part = { ...current, lines: [] };
  const flush = () => {
    const text = part.lines.join('\n').trim();
    if (!text) return;
    parts[part.to].push(text);
    mapping.push({ heading: part.heading, to: part.to, chars: text.length });
  };
  let fenced = false;
  for (const line of summary.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (!heading) {
      part.lines.push(line);
      continue;
    }
    const level = heading[1].length;
    const to = HEADINGS.get(normal(heading[2]));
    if (to) {
      flush();
      current = { heading: heading[2].trim(), to, level };
      part = { ...current, lines: [] };
    } else if (current.level > 0 && level > current.level) {
      // A sub-heading of the section it follows.
      part.lines.push(line);
    } else {
      flush();
      current = { heading: heading[2].trim(), to: PROBLEM_SECTIONS[0], level: 0 };
      part = { ...current, lines: [`${'#'.repeat(Math.max(3, level))} ${heading[2].trim()}`] };
    }
  }
  flush();
  const sections = Object.fromEntries(PROBLEM_SECTIONS.map((id) => [id, parts[id].join('\n\n')]));
  return { sections, mapping };
}

class DryRun extends Error {}

/**
 * Backfills every project that has a non-empty summary and no Problem revision. `log` is given
 * one plain object per project and the totals last. With `dryRun`, nothing is kept.
 */
export async function backfill({ state, scope, paper, dryRun = false, log = () => {} }) {
  const [rows, owners] = await Promise.all([
    state.read(
      async (sql) =>
        await sql.all(
          "SELECT id,summary FROM projects WHERE btrim(summary) <> '' ORDER BY created_at,id",
        ),
    ),
    scope.projectOwners(),
  ]);
  const ownerOf = new Map(owners.map((owner) => [owner.projectId, owner.source]));
  const totals = { projects: rows.length, written: 0, skipped: 0, failed: 0, dryRun };
  for (const row of rows) {
    const { sections, mapping } = problemFromSummary(row.summary);
    const line = { projectId: row.id, summaryChars: row.summary.length, mapping };
    try {
      await state
        .transaction(async (tx) => {
          const owner = ownerOf.get(row.id);
          const caller = owner
            ? sourceCaller(owner)
            : await scope.serviceActor('paper', row.id, tx);
          line.as = owner ? 'operator' : 'paper service';
          line.actorId = caller.actorId;
          const { current } = await paper.document(caller, 'problem', tx);
          if (current.revision > 0) {
            line.result = 'skipped: has a Problem';
            return;
          }
          const changes = PROBLEM_SECTIONS.filter((id) => sections[id]).map((id) => ({
            id,
            content: sections[id],
          }));
          const written = await paper.patch(
            caller,
            { kind: 'problem', expectedRevision: 0, changes, requestId: REQUEST_ID },
            tx,
          );
          line.result = dryRun ? 'would write' : 'written';
          line.revision = written.revision;
          if (dryRun) throw new DryRun();
        })
        .catch((error) => {
          if (!(error instanceof DryRun)) throw error;
        });
      // Counted once its transaction committed, or was rolled back as rehearsed.
      if (line.result === 'skipped: has a Problem') totals.skipped++;
      else totals.written++;
    } catch (error) {
      line.result = 'failed';
      line.error = { code: error?.code ?? 'error', message: String(error?.message ?? error) };
      totals.failed++;
    }
    log(line);
  }
  log({ totals });
  return totals;
}

if (process.env.MERV_PROBLEM_BACKFILL === '1') {
  const { PostgresState } = await import('@merv/state');
  const { ProjectScope } = await import('@merv/scope');
  const { PaperService } = await import('@merv/paper');
  const url = process.env.MERV_DB_URL;
  const schema = process.env.MERV_TS_DB_SCHEMA;
  if (!url || !schema) throw new Error('Run only inside the configured Main container');
  const state = await PostgresState.open({
    connectionString: url,
    schema,
    maxConnections: 2,
    readConnections: 2,
  });
  try {
    const scope = new ProjectScope(state);
    await scope.initialize();
    // Paper's migrations are its running release's to apply; its service needs no other start.
    const paper = new PaperService(state, scope, {});
    const totals = await backfill({
      state,
      scope,
      paper,
      dryRun: process.argv.includes('--dry-run'),
      log: (line) => console.log(JSON.stringify(line)),
    });
    if (totals.failed) process.exitCode = 1;
  } finally {
    await state.close();
  }
}
