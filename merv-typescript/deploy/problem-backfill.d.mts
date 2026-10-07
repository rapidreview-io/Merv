import type { Scope, State } from '@merv/contracts';
import type { Paper } from '@merv/paper/types';

type Section = 'problem' | 'scope' | 'goals' | 'constraints';

/** The fixed request id of each project's Paper command. */
export const REQUEST_ID: string;

/** A summary as the Problem's four sections, and where each part of it went. */
export function problemFromSummary(summary: string): {
  sections: Record<Section, string>;
  mapping: { heading: string; to: Section; chars: number }[];
};

/** One project's line, as the script prints it. */
export interface BackfillLine {
  projectId: string;
  summaryChars: number;
  mapping: { heading: string; to: Section; chars: number }[];
  as?: 'operator' | 'paper service';
  actorId?: string;
  result: 'written' | 'would write' | 'skipped: has a Problem' | 'failed';
  revision?: number;
  error?: { code: string; message: string };
}

export interface BackfillTotals {
  projects: number;
  written: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
}

export function backfill(input: {
  state: State;
  scope: Pick<Scope, 'projectOwners' | 'serviceActor'>;
  paper: Pick<Paper, 'document' | 'patch'>;
  dryRun?: boolean;
  log?: (line: BackfillLine | { totals: BackfillTotals }) => void;
}): Promise<BackfillTotals>;
