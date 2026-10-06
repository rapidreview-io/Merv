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
