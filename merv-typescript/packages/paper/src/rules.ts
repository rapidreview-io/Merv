import { visible } from '@merv/contracts';

// The Problem's rules, which Research applies before a cycle starts: pure, so it imports them
// without depending on the Paper service.

/** The Problem's four fixed sections, in paper order. */
export const PROBLEM_SECTIONS = ['problem', 'scope', 'goals', 'constraints'] as const;

/** Whether every Problem section of this revision has something to read. */
export const problemDefined = (problem: { sections: readonly { id: string; content: string }[] }) =>
  PROBLEM_SECTIONS.every((id) =>
    problem.sections.some((section) => section.id === id && visible(section.content)),
  );

/**
 * What review.start and review.get tell a scientific reviewer about the paper, which its
 * reviewers keep: each reviewing owner puts its own return routes before it.
 */
export const PAPER_REVIEW_GUIDANCE =
  'Reviewers own Methods/Results updates: include your own paperChanges: {documents: [{kind: methods or results, expectedRevision, changes: [{id, title, content}]}]}. Cite experiments as [Experiment name](/experiments/EXPERIMENT_ID), using the actual name as the visible label and keeping IDs in link destinations. Read the current paper first, distinguish planned work from established findings, and integrate the evidence into the project narrative. Keep paper updates on a design brief, usually one or two sentences; for results and syntheses you may add comprehensive detail when it helps explain the project’s trajectory and informs what comes next. Edits save with any verdict; if none are needed, explain why in notes.';
