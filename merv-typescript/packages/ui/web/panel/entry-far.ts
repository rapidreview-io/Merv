/** A turn read from afar (desk.read report), or as the stream carried it, in the shape a finished entry reads. Pure. */
import type { AgentResult } from './agent-cards';

/** A turn read from afar, as Merv's thread and runmerv.com have it (desk.read report), in the shape an entry reads. */
export interface FarReport {
  said?: string;
  state?: string;
  mixed?: boolean;
  files: {
    path: string;
    state?: 'binary' | 'too_large' | 'unavailable' | 'omitted';
    hunks: { id: string; diff: string }[];
  }[];
  activity?: { kind: string; title: string; done: boolean; failed?: boolean; at: string }[];
}
const STATES = new Set(['working', 'finished', 'failed', 'stopped']);
export function resultOf(report: FarReport): AgentResult {
  return {
    said: report.said ?? '',
    cut: false,
    state: (STATES.has(report.state ?? '') ? report.state : 'finished') as AgentResult['state'],
    ...(report.mixed && { mixed: true }),
    files: report.files.map((file) => {
      const lines = file.hunks.flatMap((hunk) => hunk.diff.split('\n'));
      return {
        path: file.path,
        status: 'modified' as const,
        added: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
        removed: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
        ...(file.state && { state: file.state }),
        hunks: file.hunks,
      };
    }),
    ...(report.activity && {
      activity: report.activity.map((step, n) => ({ item: `${step.at}:${n}`, ...step })),
    }),
  };
}

/** What the stream carried of a turn, for when its Mac cannot be read: its words and its files' names, never their
 *  lines. `unreachable`, so it is never kept in place of the turn itself, and is read again next time. */
export interface Carried {
  said?: string;
  cut?: boolean;
  outcome?: 'finished' | 'failed' | 'stopped';
  changes?: { path: string; added: number; removed: number }[];
  review?: { of: string; title: string; verdict: string; changed?: boolean };
}
export const carriedResult = (card: Carried): AgentResult => ({
  said: card.said ?? '',
  cut: !!card.cut,
  state: card.outcome ?? 'finished',
  unreachable: true,
  ...(card.review && {
    review: {
      of: card.review.of,
      title: card.review.title,
      verdict:
        card.review.verdict === 'pass' || card.review.verdict === 'needs changes'
          ? card.review.verdict
          : 'none',
      ...(card.review.changed && { changed: true }),
    },
  }),
  files: (card.changes ?? []).map((file) => ({
    path: file.path,
    status: 'modified' as const,
    added: file.added,
    removed: file.removed,
    state: 'unavailable' as const,
    hunks: [],
  })),
});
