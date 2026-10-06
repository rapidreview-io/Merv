/**
 * Which of Code's blockers a person reads, and what each one asks of them.
 *
 * The standing line speaks to the person (docs/UI_DESIGN.md ruling 11), and the ruling of
 * 2026-09-22 narrows the older "no blocker is printed" to exactly the codes whose next
 * move is a person's: somebody merges, binds, imports, releases, extends a limit, or acts
 * on the project's publication. Every other code Code publishes is work waiting on the
 * server, and the node's state word and the Act ladder already say that, so nothing here
 * prints it.
 *
 * A sentence is made from the blocker's own facts and never from the server's words, which
 * are written for the agent holding the tool and stay folded behind `Agent instructions`
 * wherever a page draws them. Pure, and free of React and of the DOM, which is what lets
 * the whole vocabulary be read in a test, and lets the server's Running contribution write
 * the very sentence the Code page writes.
 */

import type { BlockerMove, CodeBlockerGroup, PersonMove } from './models.js';

export type { BlockerMove, PersonMove };

/**
 * Which of four things a blocker's code says is holding work up. Quarantine is the strongest
 * word: nothing may ever be built on it again. A writer stuck mid-generation is recoverable
 * and waits with every other code, which is work waiting on the server.
 */
export const blockerGroup = (code: string): CodeBlockerGroup =>
  /conflict/.test(code)
    ? 'conflict'
    : /quarantin/.test(code)
      ? 'quarantine'
      : /publish|publication/.test(code)
        ? 'publication'
        : 'waiting';

/** Names records by id. The browser's RecordNames, a ReadonlyMap, is one. */
export interface NameLookup {
  get(id: string): { name: string } | undefined;
}

/** The facts of one blocker, in the shape every reading of one carries. */
export interface CodeBlocker {
  code: string;
  /** The server's words to the agent; never read here. */
  message?: string;
  /** Which kind of its code this blocker is, in the server's machine word. */
  cause?: string;
  /** Stable within a provider and instance. On a base, only `main` waits on a person. */
  key?: string;
  /** The recovery action, in the server's own words; folded, and never the sentence. */
  next?: string;
  related?: readonly { kind: string; id: string; label: string }[];
  /** When this key first took this code, which is how long the person has been owed it. */
  since?: string;
}

/** Where the reviewed merge and the publication controls stand. */
const CANVAS = '/code';

/**
 * The five refusals the server groups under one admission code, by the cause it names. Each is
 * a cap or a budget somebody set.
 */
const CAP: Record<string, string> = {
  budget_exceeded: 'The budget set for this project is spent',
  capacity_full: 'The service is at the capacity set for it',
  dispatch_disabled: 'Dispatch is paused for this project',
  sessions_unavailable: 'Sessions are unavailable, so this merge cannot run',
  usage_unavailable: 'The budget cannot be read, so this merge cannot be admitted',
};
/** Whether service admission's refusal is one of those, which Code publishes as the cause. */
export const admissionCause = (word: string | null | undefined): word is string =>
  !!word && Object.hasOwn(CAP, word);

/** The record a blocker is about, by the name this app knows it by, then the server's. */
const subject = (blocker: CodeBlocker, names?: NameLookup) => {
  const first = blocker.related?.[0];
  return first && (names?.get(first.id)?.name ?? first.label);
};

/**
 * One blocker as a move, or null where its next move is not a person's. The sentence names
 * no digest and no identifier: a base key names nobody, so the work it holds up is said
 * instead.
 */
export function personMove(blocker: CodeBlocker, names?: NameLookup): PersonMove | null {
  switch (blocker.code) {
    case 'code_publication_local_pending':
      return {
        sentence: 'Waiting for the reviewed commit to reach Merv main',
        who: 'The server',
        whose: 'nobody',
      };
    case 'code_publication_pending': {
      // Between acceptance and the first sync there is no pull request yet, and the blocker
      // says so by carrying none. Nothing is merged in that window and nobody is owed it,
      // so the wait is named and neither a person nor a control is.
      if (!blocker.related?.some((item) => item.kind === 'pull-request'))
        return {
          sentence: 'The publication for this work has not opened its pull request yet',
          who: 'The server',
          whose: 'nobody',
        };
      // The reviewed merge is a control this app draws, on Code, beside the pull request
      // itself; the number stands there too, so the sentence does not repeat it. The label
      // is the destination control's own words, as the verb table asks.
      return {
        sentence: 'Waiting on a person to merge the pull request',
        who: 'A signed-in operator',
        whose: 'operator',
        control: { label: 'Merge reviewed proposal', to: CANVAS },
      };
    }
    case 'code_publication_stale':
      // Nobody acts — the founder's ruling of 2026-09-22 calls the successor automatic —
      // and a person still deserves to know why the cycle waits.
      return {
        sentence: 'Main has moved past this accepted code',
        who: 'A successor task',
        whose: 'nobody',
      };
    case 'code_publication_disabled':
      return {
        sentence: 'Publication is disabled for this project until an operator clears it',
        who: 'An operator',
        whose: 'operator',
      };
    case 'code_publication_setup_required':
      return {
        sentence: 'Publication setup needs an operator before this code can reach main',
        who: 'An operator',
        whose: 'operator',
      };
    case 'code_publication_closed':
      // Code never reads a closed pull request again, so a reopen changes nothing here.
      return {
        sentence: 'The pull request was closed unmerged; an operator creates successor work',
        who: 'An operator',
        whose: 'operator',
      };
    case 'code_publication_incident':
      return {
        sentence: 'A publication incident is kept here until an operator clears it',
        who: 'An operator',
        whose: 'operator',
      };
    case 'code_publish_unverifiable':
      return {
        sentence: 'This work was to publish to main and no publication opened for it',
        who: 'An operator',
        whose: 'operator',
      };
    case 'code_base_admission':
      return {
        sentence:
          (admissionCause(blocker.cause) && CAP[blocker.cause]) ||
          'A limit somebody set is holding this merge',
        who: 'An administrator',
        whose: 'administrator',
      };
    case 'code_merge_conflict': {
      // A conflict waits on the resolution task, which is work already in flight and
      // nobody's to make; only a resolution its review budget suspended waits on a person.
      if (blocker.cause !== 'suspended') return null;
      const task = subject(blocker, names);
      return {
        sentence: `The resolution ${task ? `“${task}” ` : ''}is suspended; an administrator extends its review limit`,
        who: 'An administrator',
        whose: 'administrator',
      };
    }
    case 'code_base_pending':
      if (blocker.key === 'initialization')
        return {
          sentence: 'Merv is initializing this project’s Git repository',
          who: 'The server',
          whose: 'nobody',
        };
      // Every other pending base names work that has not been accepted yet, which is that
      // record's own business; only main waits on somebody binding or importing it.
      return blocker.key === 'main'
        ? {
            sentence: 'Main is not in this project’s repository yet',
            who: 'An administrator',
            whose: 'administrator',
          }
        : null;
    case 'code_quarantined':
      // Both producers of this code agree the retained base is spent; only the capture
      // quarantine has a release at all, and then only for a false alarm. What ends the
      // wait for everyone waiting on it is the operator replanning them.
      return {
        sentence:
          'Quarantined: the code kept here cannot be used, and an operator replans the work waiting on it',
        who: 'An operator',
        whose: 'operator',
      };
    default:
      return null;
  }
}

/**
 * Per instance, the first of its blockers whose next move is a person's, named by its
 * provider and key, with that move: Code's word on a record's blocker, which Home attaches
 * to that blocker. Its wait on the server, a move that is nobody's, is one of them: the
 * record it holds is no move of its owner's either.
 */
export function heldMoves(
  blockers: readonly (CodeBlocker & { instanceId: string; provider: string; key: string })[],
): BlockerMove[] {
  const first = new Map<string, BlockerMove>();
  for (const { instanceId, provider, key, ...blocker } of blockers) {
    if (first.has(instanceId)) continue;
    const move = personMove({ ...blocker, key });
    if (move) first.set(instanceId, { instanceId, provider, key, move });
  }
  return [...first.values()];
}

/** The first blocker of a list whose next move is a person's, with that move. */
export function firstPersonMove(
  blockers: readonly CodeBlocker[],
  names?: NameLookup,
): { blocker: CodeBlocker; move: PersonMove } | null {
  for (const blocker of blockers) {
    const move = personMove(blocker, names);
    if (move) return { blocker, move };
  }
  return null;
}
