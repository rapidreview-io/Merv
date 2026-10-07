import type { Json } from '@merv/contracts/data';

/*
 * Sidebar rows as data, with no server import: ui.shell's answer is typed by these on both
 * sides, the registry and the browser bundle.
 */

/** Live state a row owner reports alongside its navigation entry. */
export interface UiRowStatus {
  state?: 'ready' | 'degraded' | 'unavailable';
  count?: number;
  detail?: string;
}

/** A sidebar row's data, as the browser reads it too: everything but the owner's reads. */
export interface UiRowFields {
  id: string;
  label: string;
  /**
   * Where the rail places the row: `lead` just under Home, `top` under that, `settings` in the
   * foot, `hidden` nowhere (its routes and its read still serve); any other group is the
   * section it is listed under.
   */
  group: string;
  order: number;
  /** Browser route under /ui, beginning with a slash. */
  path: string;
  /** The workflow whose records this row lists: each opens at `${path}/${id}`, on every page. */
  workflow?: string;
  /**
   * Workflows whose records live inside this row's records, as a lens lives in its wave: each
   * opens at `${path}/${id}` too, and the page finds the record that holds it.
   */
  holds?: readonly string[];
  /** Deeper addresses are rooms of this one page, not records, so the shell still titles them. */
  rooms?: true;
  /** The rail lists the row only while its status counts something: an empty archive is no place. */
  whenCounted?: true;
  view: { kind: string; [key: string]: Json };
  /** How Needs you says a row's records (its `home`) are the reader's move, in the owner's words. */
  needs?: UiRowNeeds;
  /** What the shell says of `workflow`'s states that its deployed definition does not. */
  states?: Record<string, UiStateWords>;
}

/**
 * One state of a row's workflow, in the owner's words. The catalog already says the rest: a
 * state left through review.submit is a review gate, and an end is an end.
 */
export interface UiStateWords {
  /** Work not yet begun: its stage reads grey, before any of the program's work. */
  idle?: true;
  /** At a review gate: what crossing into it says its producer did, e.g. 'Delivered'. */
  submitted?: string;
}

/**
 * The words Needs you says a row's records in: the shell has none of its own for any workflow.
 * Whose move a record is, and the sentence asking it, are its gate's (`yours`), as its program
 * describes the record to Workflows.
 */
export interface UiRowNeeds {
  /** The fields of a `home` record that name it and whose it is. */
  name: string;
  owner: string;
  /** What a reviewer is asked, by the state the record waits in. */
  reads?: Record<string, string>;
  /** Blocker codes on which the record stopped on its last failed prerequisite; others stop nothing. */
  stops?: string[];
  /** The records only name the reviews of them, and are never a move of their own. */
  subjectOnly?: true;
  /**
   * The field of a record listing records inside it, each with its `id` and `workflow`, such as
   * a wave's lenses: their gates may name the reader's move too, which stands under the record.
   */
  parts?: string;
}

/** A row as ui.shell describes it to the browser. */
export interface UiRowDescription extends UiRowFields {
  status: UiRowStatus;
  readable: boolean;
}
