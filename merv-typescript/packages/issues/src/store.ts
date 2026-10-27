import {
  check,
  newId,
  sha256Hex,
  type SqlValue,
  type State,
  type Transaction,
} from '@merv/contracts';
import {
  errorFacts,
  type ErrorFacts,
  type IssueCase,
  type IssueClass,
  type IssueLevel,
  type IssueRefs,
  type IssueReport,
  type IssueRow,
  type IssueState,
  type IssueStore as IssueService,
  type IssueTarget,
} from '@merv/contracts/issues';
import { clip, cleanText, redacted } from '@merv/contracts/text';
import { title, type AlertDigest, type AlertSink } from './alerts.js';

const MINUTE = 60_000;
/** Pending fingerprints, subjects (and so cases) one fingerprint keeps a flush, loop windows. */
const KEYS = 2000;
const SUBJECTS = 20;
const LOOPS = 5000;
/** Reports of one fingerprint and subject in a fixed ten-minute window that make a loop. */
const LOOP = 15;
/** Reports and resolves one fingerprint holds between flushes. */
const OPS = 8;
const CLASSES: readonly IssueClass[] = ['tool', 'question', 'platform'];
const LEVELS: readonly IssueLevel[] = ['notice', 'warn', 'severe'];
const higher = (a: IssueLevel, b: IssueLevel) => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);
const iso = (ms: number) => new Date(ms).toISOString();
const word = (value: unknown, max: number) => cleanText(value, max) || undefined;
/** Refs as kept: ids only, each clipped, at most 30 of them. */
const ids = (refs: IssueRefs | undefined): IssueRefs =>
  Object.fromEntries(
    Object.entries(refs ?? {})
      .slice(0, 30)
      .map(([name, value]) => [name, typeof value === 'string' ? cleanText(value, 200) : value]),
  );

/** One subject's reports within a flush: the case it may be kept as. */
interface Bucket {
  subject: string | null;
  n: number;
  at: string;
  level: IssueLevel;
  status: number | null;
  refs: IssueRefs;
  error: ErrorFacts | null;
  note: string | null;
}
/** Consecutive reports of one fingerprint, with no resolve between them. */
interface Group {
  n: number;
  at: string;
  level: IssueLevel;
  loop: boolean;
  standing: boolean;
  note: string | null;
  buckets: Bucket[];
}
/** A fingerprint's reports and resolves, in arrival order. */
interface Pending {
  id: string;
  class: IssueClass;
  where: string;
  code: string;
  key: string | null;
  ops: (Group | 'resolve')[];
}
interface Row {
  id: string;
  fingerprint: string;
  class: IssueClass;
  where_at: string;
  code: string;
  key: string | null;
  first_at: string;
  level: IssueLevel;
  loop: boolean;
  standing: boolean;
  state: IssueState;
  count: number;
  hour_at: string;
  hour_count: number;
  peak_hour: number;
  stored: number;
  kept_at: string | null;
  kept_subject: string | null;
  note: string | null;
  opened_at: string;
  last_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  alerted_at: string | null;
  reopened: number;
}
const columns = (names: string) => names.split(' ') as (keyof Row)[];
const IDENTITY = columns('id fingerprint class where_at code key first_at');
const MUTABLE = columns(
  'level loop standing state count hour_at hour_count peak_hour stored kept_at kept_subject note opened_at last_at resolved_at resolved_by alerted_at reopened',
);
/** An issue as the admin reads it, with up to five projects its kept cases name. */
const ISSUE = `SELECT id, class, where_at AS "where", code, key, level, loop, state, count,
  peak_hour AS "peakHour", note, first_at AS "firstAt", opened_at AS "openedAt", last_at AS "lastAt",
  resolved_at AS "resolvedAt", resolved_by AS "resolvedBy",
  ARRAY(SELECT DISTINCT o.project_id FROM issue_occurrences o WHERE o.issue_id=i.id AND o.project_id IS NOT NULL LIMIT 5) AS projects
  FROM issues i`;

/** Rows in statements of at most 100 each; booleans as PostgreSQL reads them. */
async function insert(tx: Transaction, head: string, rows: unknown[][], tail = '') {
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await tx.run(
      `${head} VALUES ${chunk.map((row) => `(${row.map(() => '?').join(',')})`).join(',')} ${tail}`,
      ...chunk.flat().map((v) => (typeof v === 'boolean' ? String(v) : (v as SqlValue))),
    );
  }
}

/**
 * The `issues` service. A report waits for its writer's commit, folds into a bounded map and
 * reaches PostgreSQL at the next flush, which applies the class-generic rules: episodes, counts,
 * the hourly spike, loops, standing conditions and case sampling. Nothing here throws at an owner.
 */
export class IssueStore implements IssueService {
  private pending = new Map<string, Pending>();
  private readonly loops = new Map<string, { window: number; count: number }>();
  private dropped = 0;
  private failures = 0;
  private fellBack = -Infinity;
  private flushing?: Promise<void>;
  private sending?: Promise<void>;
  private alertFailures = 0;
  private alertAt = 0;

  constructor(
    private readonly state: State,
    private readonly sinks: readonly AlertSink[] = [],
    private readonly clock: () => number = Date.now,
  ) {}

  report(issue: IssueReport): void {
    this.later(() => this.enqueue(issue, this.clock()));
  }

  resolve(target: IssueTarget): void {
    this.later(() => {
      const entry = this.entry(target);
      if (entry && entry.ops.at(-1) !== 'resolve' && entry.ops.length < OPS)
        entry.ops.push('resolve');
    });
  }

  /** After the caller's writer commits; dropped if it rolls back. */
  private later(fold: () => void) {
    try {
      this.state.afterCommit(fold);
    } catch {
      // Telemetry never decides a call.
    }
  }

  private entry(target: IssueTarget): Pending | undefined {
    const cls = CLASSES.includes(target.class) ? target.class : 'platform';
    const where = word(target.where, 120) ?? '-';
    const code = word(target.code, 120) ?? '-';
    const key = word(target.key, 300) ?? null;
    const id = `${cls}\0${where}\0${code}\0${key ?? ''}`;
    let entry = this.pending.get(id);
    // Issues' own reports always fit, so an overflow is itself recorded.
    if (!entry && this.pending.size >= KEYS && !where.startsWith('issues.'))
      return void this.dropped++;
    if (!entry) this.pending.set(id, (entry = { id, class: cls, where, code, key, ops: [] }));
    return entry;
  }

  private enqueue(r: IssueReport, now: number) {
    const entry = this.entry(r);
    if (!entry) return;
    const at = iso(now);
    const n = Number.isSafeInteger(r.n) && r.n! > 0 ? r.n! : 1;
    const status =
      Number.isInteger(r.status) && r.status! >= 0 && r.status! < 1000 ? r.status! : null;
    // The fault rule: a 500 is severe whatever its owner said.
    const level = status === 500 ? 'severe' : LEVELS.includes(r.level!) ? r.level! : 'warn';
    const subject = word(r.subject, 200) ?? null;
    const note = (r.note !== undefined && redacted(r.note, 280)) || null;
    let group = entry.ops.at(-1);
    if (group === undefined || group === 'resolve') {
      if (entry.ops.length >= OPS) return void this.dropped++;
      group = { n: 0, at, level, loop: false, standing: false, note: null, buckets: [] };
      entry.ops.push(group);
    }
    Object.assign(group, {
      n: group.n + n,
      at,
      level: higher(group.level, level),
      standing: r.standing === true,
      loop: group.loop || r.loop === true,
      note: note ?? group.note,
    });
    if (subject && !r.standing) {
      const key = `${entry.id}\0${subject}`;
      const window = Math.floor(now / (10 * MINUTE));
      const seen = this.loops.get(key);
      const count = (seen?.window === window ? seen.count : 0) + n;
      this.loops.delete(key);
      this.loops.set(key, { window, count });
      if (this.loops.size > LOOPS) this.loops.delete(this.loops.keys().next().value!);
      group.loop ||= count >= LOOP;
    }
    const bucket = group.buckets.find((b) => b.subject === subject);
    if (bucket) Object.assign(bucket, { n: bucket.n + n, level: higher(bucket.level, level) });
    else if (group.buckets.length < SUBJECTS) {
      const error = errorFacts(r.error) ?? null;
      group.buckets.push({ subject, n, at, level, status, refs: ids(r.refs), error, note });
    }
  }

  /** Writes what is pending in one transaction; a failure keeps it, bounded, for the next. */
  flush(): Promise<void> {
    return (this.flushing ??= this.write().finally(() => (this.flushing = undefined)));
  }

  private async write() {
    const now = this.clock();
    if (this.dropped)
      this.enqueue(
        { class: 'platform', where: 'issues.dropped', code: 'overflow', n: this.dropped },
        now,
      );
    this.dropped = 0;
    if (!this.pending.size) return;
    const batch = this.pending;
    this.pending = new Map();
    try {
      await this.state.transaction((tx) => this.apply(tx, batch));
      this.failures = 0;
      return;
    } catch {
      for (const [id, entry] of this.pending) {
        const older = batch.get(id);
        if (older) older.ops.push(...entry.ops.slice(0, Math.max(0, OPS - older.ops.length)));
        else if (batch.size < KEYS) batch.set(id, entry);
        else this.dropped++;
      }
      this.pending = batch;
    }
    // While the database is away nothing is recorded: say so once every 30 minutes.
    const severe = [...batch.values()].some((entry) =>
      entry.ops.some((op) => op !== 'resolve' && op.level === 'severe'),
    );
    if (++this.failures < 30 || !severe || now - this.fellBack < 30 * MINUTE) return;
    this.fellBack = now;
    const issue = { id: '', title: 'issues cannot be recorded', level: 'severe' as const };
    await this.deliver({
      at: iso(now),
      issues: [{ ...issue, loop: false, count: batch.size, openedAt: iso(now) }],
    }).catch(() => {});
  }

  private async apply(tx: Transaction, batch: Map<string, Pending>) {
    const now = this.clock();
    const hour = iso(now).slice(0, 13);
    const entries = [...batch.values()].map((entry) => ({
      ...entry,
      fingerprint: sha256Hex(JSON.stringify([entry.class, entry.where, entry.code, entry.key])),
    }));
    const found = await tx.all<Row>(
      `SELECT * FROM issues WHERE fingerprint IN (${entries.map(() => '?').join(',')}) FOR UPDATE`,
      ...entries.map((entry) => entry.fingerprint),
    );
    const rows = new Map(found.map((row) => [row.fingerprint, row]));
    const issues: Row[] = [];
    const cases: unknown[][] = [];
    for (const { fingerprint, ops, ...entry } of entries) {
      let row = rows.get(fingerprint);
      let kept = 0;
      for (const op of ops) {
        if (op === 'resolve') {
          if (row?.state === 'open')
            Object.assign(row, { state: 'resolved', resolved_at: iso(now), resolved_by: 'owner' });
          continue;
        }
        const first = op.buckets[0]?.at ?? op.at;
        const fresh = row?.state !== 'open';
        if (!row || fresh) {
          row ??= {
            id: `issue_${fingerprint.slice(0, 32)}`,
            fingerprint,
            class: entry.class,
            where_at: entry.where,
            code: entry.code,
            key: entry.key,
            first_at: first,
            count: 0,
            hour_at: hour,
            hour_count: 0,
            peak_hour: 0,
            note: null,
            reopened: -1,
          } as Row;
          // A new episode: its own level, alert and sample.
          Object.assign(row, {
            state: 'open',
            opened_at: first,
            level: op.level,
            loop: false,
            stored: 0,
            kept_at: null,
            kept_subject: null,
            resolved_at: null,
            resolved_by: null,
            alerted_at: null,
            reopened: row.reopened + 1,
          });
        }
        // A standing condition counts once an episode.
        const n = op.standing ? Number(fresh) : op.n;
        let level = higher(row.level, op.level);
        row.count += n;
        row.hour_count = row.hour_at === hour ? row.hour_count + n : n;
        row.hour_at = hour;
        row.peak_hour = Math.max(row.peak_hour, row.hour_count);
        // The spike rule, which re-arms an alert at most once an hour.
        const spike = entry.class === 'platform' ? 10 : 60;
        if (entry.class !== 'question' && !op.standing && row.hour_count >= spike) {
          level = 'severe';
          if (row.alerted_at && row.alerted_at < `${hour}:00:00.000Z`) row.alerted_at = null;
        }
        if (op.loop) {
          level = 'severe';
          if (!row.loop) row.alerted_at = null;
          row.loop = true;
        }
        if (level === 'severe' && row.level !== 'severe') row.alerted_at = null;
        Object.assign(row, { level, standing: op.standing, last_at: op.at });
        row.note = op.note ?? row.note;
        // Sampling: every case up to 50 an episode, then a new subject or one every ten minutes;
        // a standing condition keeps only its first.
        for (const b of op.buckets) {
          if (kept >= SUBJECTS || (op.standing && row.stored > 0)) break;
          const stale = !row.kept_at || row.kept_at <= iso(now - 10 * MINUTE);
          if (row.stored >= 50 && !stale && b.subject === row.kept_subject) continue;
          kept++;
          Object.assign(row, { stored: row.stored + 1, kept_at: b.at, kept_subject: b.subject });
          const { projectId, sessionId, instanceId, release } = b.refs;
          cases.push([
            newId('issue_case'),
            row.id,
            b.at,
            b.level,
            b.status,
            b.n,
            projectId ?? null,
            b.subject,
            sessionId ?? null,
            instanceId ?? null,
            release ?? process.env.MERV_RELEASE ?? null,
            JSON.stringify(b.refs),
            b.error && JSON.stringify(b.error),
            b.note,
          ]);
        }
      }
      if (row) issues.push(row);
    }
    await insert(
      tx,
      `INSERT INTO issues (${[...IDENTITY, ...MUTABLE].join(',')})`,
      issues.map((row) => [...IDENTITY, ...MUTABLE].map((column) => row[column])),
      `ON CONFLICT (fingerprint) DO UPDATE SET ${MUTABLE.map((c) => `${c}=excluded.${c}`).join(',')}`,
    );
    await insert(
      tx,
      'INSERT INTO issue_occurrences (id,issue_id,at,level,status,repeats,project_id,subject,session_id,instance_id,release,refs_json,error_json,note)',
      cases,
    );
  }

  /** Pushes the severe issues still owed an alert, one digest at most every five minutes. */
  alertPass(): Promise<void> {
    return (this.sending ??= this.alert().finally(() => (this.sending = undefined)));
  }

  private async alert() {
    const now = this.clock();
    if (!this.sinks.length || now < this.alertAt) return;
    const owed = await this.state.read(async (sql) => {
      const rows = await sql.all<Row>(
        "SELECT * FROM issues WHERE state='open' AND level='severe' AND alerted_at IS NULL AND where_at NOT LIKE 'issues.%' ORDER BY opened_at LIMIT 20",
      );
      if (!rows.length) return rows;
      // A durable throttle: a restart never alerts sooner.
      const last = await sql.get<{ at: string | null }>('SELECT max(alerted_at) AS at FROM issues');
      return last?.at && last.at > iso(now - 5 * MINUTE) ? [] : rows;
    });
    if (!owed.length) return;
    try {
      await this.deliver({
        at: iso(now),
        issues: owed.map((row) => ({
          id: row.id,
          title: title(row.where_at, row.code),
          level: row.level,
          loop: row.loop,
          count: row.count,
          openedAt: row.opened_at,
        })),
      });
    } catch (error) {
      // They stay owed, never dropped by age; the sink is retried after 1, 2, 4, then 10 minutes.
      this.alertAt = now + [1, 2, 4, 10][Math.min(this.alertFailures++, 3)]! * MINUTE;
      this.enqueue({ class: 'platform', where: 'issues.alert', code: 'alert_failed', error }, now);
      return;
    }
    this.alertFailures = 0;
    await this.state.transaction((tx) =>
      tx.run(
        `UPDATE issues SET alerted_at=? WHERE alerted_at IS NULL AND (id,opened_at) IN (${owed.map(() => '(?,?)').join(',')})`,
        iso(now),
        ...owed.flatMap((row) => [row.id, row.opened_at]),
      ),
    );
  }

  private async deliver(digest: AlertDigest) {
    for (const sink of this.sinks) await sink.send(digest);
  }

  /** The last flush, then one alert pass of at most ten seconds: the state store closes after. */
  async stop(): Promise<void> {
    await this.sending?.catch(() => {});
    await this.flush();
    await Promise.race([
      this.alertPass().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
    ]);
  }

  async platformIssues() {
    return await this.state.read(async (sql) => {
      const rows = await sql.all<IssueRow>(
        `${ISSUE} WHERE state='open' OR resolved_at>=? ORDER BY last_at DESC LIMIT 500`,
        iso(this.clock() - 7 * 1440 * MINUTE),
      );
      const counts = await sql.get<{ open: number; severe: number }>(
        "SELECT count(*)::int AS open, (count(*) FILTER (WHERE level='severe'))::int AS severe FROM issues WHERE state='open'",
      );
      return { rows, ...counts! };
    });
  }

  async platformIssue(id: string) {
    return await this.state.read(async (sql) => {
      const issue = await sql.get<IssueRow>(`${ISSUE} WHERE id=?`, id);
      if (!issue) return undefined;
      const cases = await sql.all<IssueCase>(
        `SELECT id, at, level, status, repeats, project_id AS "projectId", subject, release,
          refs_json::jsonb AS refs, error_json::jsonb AS error, note, NULLIF(trace_json, '{}')::jsonb AS trace
        FROM issue_occurrences WHERE _merv_rowid IN (
          SELECT min(_merv_rowid) FROM issue_occurrences WHERE issue_id=?
          UNION ALL (SELECT _merv_rowid FROM issue_occurrences WHERE issue_id=? ORDER BY _merv_rowid DESC LIMIT 50)
        ) ORDER BY _merv_rowid DESC`,
        id,
        id,
      );
      return { issue, cases };
    });
  }

  async close(id: string, by: string): Promise<IssueRow> {
    return await this.state.transaction(async (tx) => {
      await tx.run(
        "UPDATE issues SET state='resolved', resolved_at=?, resolved_by=? WHERE id=? AND state='open'",
        iso(this.clock()),
        clip(by, 200),
        id,
      );
      const issue = await tx.get<IssueRow>(`${ISSUE} WHERE id=?`, id);
      check(issue, 'not_found', 'Issue not found', 404);
      return issue;
    });
  }
}
