import { visible } from '@merv/contracts/text';

// The Problem's rules, which Research applies before a cycle starts and the browser renders the
// Introduction with: pure, so either imports them without depending on the Paper service.

/** The Problem's four fixed sections, in paper order. */
export const PROBLEM_SECTIONS = ['problem', 'scope', 'goals', 'constraints'] as const;

/** Whether every Problem section of this revision has something to read. */
export const problemDefined = (problem: { sections: readonly { id: string; content: string }[] }) =>
  PROBLEM_SECTIONS.every((id) =>
    problem.sections.some((section) => section.id === id && visible(section.content)),
  );

/**
 * The project Introduction, written from the Problem: its filled sections in paper order, each
 * under its own Markdown heading. The Problem is the one source of what the project is.
 */
export const introductionFrom = (problem: {
  sections: readonly { id: string; title: string; content: string }[];
}): string =>
  problem.sections
    .filter(
      (section) =>
        (PROBLEM_SECTIONS as readonly string[]).includes(section.id) && section.content.trim(),
    )
    .map((section) => `## ${section.title}\n\n${section.content.trim()}`)
    .join('\n\n');

/**
 * What review.start and review.get tell a scientific reviewer about keeping the paper, said the
 * same by every reviewing owner: each says first which of its reviewers keep Methods/Results, and
 * after it how much they write and that edits save with any verdict.
 */
export const PAPER_REVIEW_GUIDANCE =
  'own Methods/Results updates: include your own paperChanges: {documents: [{kind: methods or results, expectedRevision, changes: [{id, title, content}]}]}. Cite experiments as [Experiment name](/experiments/EXPERIMENT_ID), using the actual name as the visible label and keeping IDs in link destinations. Read the current paper first, distinguish planned work from established findings, and integrate the evidence into the project narrative.';
