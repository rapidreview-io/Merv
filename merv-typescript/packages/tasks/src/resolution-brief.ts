import type { ResolutionWork, ResolutionWorkCreator } from '@merv/code-work/types';
import type { ServiceTaskCreator } from './types.js';

/** Each section gets its own room, so long provenance cannot push another out of the brief. */
const bounded = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit)}\n[Truncated in the task brief.]`;

/** The task a worker reads for the reviewed work Code asks for, worded from Code's facts. */
export function resolutionBrief(work: ResolutionWork): {
  title: string;
  goal: string;
  checks: string[];
} {
  if (work.kind === 'sync')
    return {
      title: `Integrate GitHub ${work.branch} into Merv main`,
      goal: `Integrate the retained GitHub head ${work.head} with Merv main ${work.main}. Use code.merge, resolve conflicts and retain both histories. Do not replace either history, force-push, or publish to GitHub. This task must pass independent review before Merv main advances.`,
      checks: [
        `The delivered commit contains both ${work.main} and ${work.head}, with a merge whose ordered parents are the Merv checkpoint and the selected GitHub head.`,
        'Resolve conflicts without discarding either side unintentionally; document reconciliation choices.',
        'Run the relevant build and tests, retain results, and disclose checks that could not run.',
      ],
    };
  const { left, right, conflict, check } = work;
  const side = (inputs: typeof left.inputs) =>
    inputs
      .map(
        (input) =>
          `${input.commit}: ${(input.units.length ? input.units.map((unit) => `${unit.name ?? unit.id} (${unit.id})`) : ['Accepted input']).join('; ')}`,
      )
      .join('\n');
  const titleSide = (inputs: typeof left.inputs) => {
    const items = inputs.flatMap((input) =>
      input.units.length
        ? input.units.map((unit) => unit.name ?? 'Accepted work')
        : ['Accepted work'],
    );
    const first = items[0] ?? 'Accepted work';
    const label = first.length > 80 ? `${first.slice(0, 79)}…` : first;
    return `‘${label}’${items.length > 1 ? ` and ${items.length - 1} more` : ''}`;
  };
  const [from, to] = [titleSide(left.inputs), titleSide(right.inputs)];
  // A failing project check of a clean merge is a conflict with no paths: every heading and
  // the opening sentence a worker reads first would lie, so the brief says what has to pass.
  const checked = check && !conflict.paths.length ? check : null;
  const sections = checked
    ? [
        `Project check:\n\`${checked.command}\` ${checked.timedOut ? `timed out after ${checked.timeoutSeconds} seconds` : `exited ${checked.exitCode}`} on ${checked.machine}. The merge itself was clean; this command has to pass on the merged tree.`,
        `Check output:\n${checked.output}`,
      ]
    : [
        `Conflicting paths:\n${bounded(conflict.paths.join('\n'), 4000)}`,
        `Git messages:\n${bounded(conflict.messages, 4000)}`,
      ];
  return {
    title: checked
      ? `Make the project check pass on ${from} with ${to}`
      : `Merge ${from} with ${to}`,
    goal: `${
      checked
        ? `The merge of ${from} and ${to} is clean; its project check failed.`
        : `Resolve conflicts between ${from} and ${to}.`
    }\n\nLeft input ${left.commit} (the workspace starts here):\n${bounded(side(left.inputs), 8000)}\n\nRight input ${right.commit} (frozen):\n${bounded(side(right.inputs), 8000)}\n\n${sections[0]}\n\nUse code.merge operation start on the clean initial checkout; wait for code.operation. The right input is frozen and never follows a branch. ${checked ? 'Make the command pass on the merged tree, retain its commands and results as evidence' : 'Resolve the files, retain conflict decisions and test evidence'}, then use code.merge operation complete. code.commit and final captures save single-parent WIP before completion. After interruption on any machine, continue from the downloaded checkpoint and its pendingMerge metadata; do not restart over saved WIP. After the first completed merge, later rounds use code.commit for corrections on this same branch. Retain the operation receipt, parent evidence, and commands and results for independent review.\n\n${sections[1]}`,
    checks: [
      `The first completed merge on the task branch must have exactly two parents: the current checkpoint descending from ${left.commit}, and frozen right input ${right.commit}, in that order. Later rounds add ordinary corrective commits.`,
      // A check failure has no conflicting path to resolve; asking for one would contradict
      // the brief's own Project check section.
      checked
        ? 'Leave no conflict markers.'
        : 'Resolve every conflicting path and leave no conflict markers.',
      // A merge whose check failed owes the failing command passing, not paths resolved: this
      // is where "resolution rounds supply reviewed verification evidence" reaches a worker.
      check
        ? `The project check \`${check.command}\` ${check.timedOut ? 'timed out' : `failed with exit ${check.exitCode}`}. Make it pass on the merged tree, and retain the command and its result as review evidence.`
        : 'Run the project build and tests as far as this workspace permits; retain commands, results, and any checks that could not run as review evidence.',
    ],
  };
}

/** Code's resolution work, opened as service tasks briefed from its facts. */
export const resolutionTasks = (tasks: ServiceTaskCreator): ResolutionWorkCreator => ({
  create: ({ work, ...input }, tx) => tasks.create({ ...input, ...resolutionBrief(work) }, tx),
  resume:
    'A signed-in human operator must extend review_rounds with workflow.extend_limit to resume this same task',
});
