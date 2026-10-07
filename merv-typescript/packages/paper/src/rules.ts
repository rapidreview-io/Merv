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
 * What a scientific reviewer who keeps the paper is told, in its handoff and by review.get: read
 * the paper, submit its own Methods/Results edits with the verdict, and say why when there are
 * none. Each owner's published recipe or policy embeds it exactly, so it never changes in place.
 */
export const PAPER_REVIEWER_INSTRUCTION =
  'You are responsible for updating the project paper’s Methods and Results in perspective of the whole project. Read paper.read immediately before preparing edits. Submit your own paperChanges: {documents: [{kind: "methods" or "results", expectedRevision: current revision, changes: [{id, title, content}]}]} with review.submit. Revise existing sections rather than appending a review log; cite experiments with Markdown links [Experiment name](/experiments/EXPERIMENT_ID), using each experiment’s actual name as the visible label, and cite exact evidence. Keep stable IDs only in link destinations. Paper edits save with any verdict, so describe rejected or inconclusive work honestly without presenting it as accepted findings. If no edits are warranted, explain why in notes.';
