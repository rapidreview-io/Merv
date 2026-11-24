/** What a job's row in the project's list says. Owners send times, never sentences about them; the words are made here
 *  against one clock the column holds, so a stale read stops every clock at once. */
import { askTitle, type JobView } from './rows';

/** A span in one short word: "40m", "3h", "2d"; under a minute, nothing at all. */
export function span(from?: string, to: number | string = Date.now()): string {
  const start = from ? Date.parse(from) : NaN,
    end = typeof to === 'number' ? to : Date.parse(to);
  const s = (end - start) / 1000;
  if (!Number.isFinite(s) || s < 60) return '';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const rounds = (n: number) => `${n} ${n === 1 ? 'round' : 'rounds'}`;

/** What a job's row says of it, without any clock: what a screen reader is told when it changes. "reviewing 2/3",
 *  "needs you", "passed in 2 rounds", "stopped in round 2". */
export function steadyWords(job: Pick<JobView, 'state' | 'step' | 'round' | 'rounds'>): string {
  const round = job.round ?? 1;
  if (job.step === 'shipped') return 'shipped';
  if (job.step === 'shipping' && job.state === 'running') return 'shipping';
  if (job.state === 'done') return `passed in ${rounds(round)}`;
  if (job.state === 'stopped') return `stopped in round ${round}`;
  if (job.state === 'needs') return 'needs you';
  return `${job.step ?? 'working'} ${round}/${Math.max(round, job.rounds?.max ?? round)}`;
}

/** When a job last moved, for the time a row shows under the pointer. */
export const jobMoved = (job: Pick<JobView, 'stageSince' | 'since' | 'at'>): string =>
  job.stageSince ?? job.since ?? job.at ?? '';

/** Whether the person has opened a job that ended. Kept on this Mac across restarts. */
const SEEN = 'merv:job-opened:';
function jobOpened(id: string): boolean {
  try {
    return localStorage.getItem(SEEN + id) === 'yes';
  } catch {
    return false;
  }
}
/** The person viewed the job's entry: pressed its row, or unfolded it in the main thread. */
export function openJob(id: string) {
  if (jobOpened(id)) return;
  try {
    localStorage.setItem(SEEN + id, 'yes');
  } catch {
    /* Opened for this page only. */
  }
  if (typeof window !== 'undefined')
    window.dispatchEvent(new window.CustomEvent('merv:job-opened', { detail: id }));
}

/** A job's title as its row says it. */
export const jobTitle = (job: Pick<JobView, 'title'>) => askTitle(job.title) || 'Job';
