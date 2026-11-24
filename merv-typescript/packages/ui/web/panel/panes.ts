/** Pane bounds leave the divider available even when a native page is above the panel. */
export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
const DIVIDER = 6;
/** The window's top strip in the chat's stage, where its own buttons sit and which only moves the window.
 *  The board begins immediately below it (the main process's STAGE.top), with its controls inside the canvas. */
export const STRIP = 44;
export const paneShare = (share: number) =>
  Number.isFinite(share) ? Math.max(0.15, Math.min(0.85, share)) : 0.5;
/** `across`: two panes stand side by side, as they do when the chat has the window; otherwise one is above the other. */
export function paneRects(
  width: number,
  height: number,
  split: boolean,
  share: number,
  across = false,
): PaneRect[] {
  width = Math.max(0, Math.round(width));
  height = Math.max(0, Math.round(height));
  if (!split) return [{ x: 0, y: 0, width, height }];
  if (across) {
    const gap = Math.min(DIVIDER, width);
    const left = Math.round((width - gap) * paneShare(share));
    return [
      { x: 0, y: 0, width: left, height },
      { x: left + gap, y: 0, width: width - gap - left, height },
    ];
  }
  const gap = Math.min(DIVIDER, height);
  const top = Math.round((height - gap) * paneShare(share));
  return [
    { x: 0, y: 0, width, height: top },
    { x: 0, y: top + gap, width, height: height - gap - top },
  ];
}

/** At either edge, keep the pane the person dragged towards the middle. */
export function collapsedPane(y: number, height: number): 0 | 1 | undefined {
  if (y <= 32) return 0;
  if (y >= height - 32) return 1;
  return undefined;
}

export interface PaneTarget {
  kind: 'list' | 'thread' | 'past' | 'merv' | 'new' | 'browser';
  id?: string;
  /** With a project's main thread: the job of it whose own page shows in its place. Back returns to the thread. */
  job?: string;
  asideOf?: string;
  provider?: string;
  evidence?: { from?: string; through?: string };
}
export interface Pane {
  key: number;
  target: PaneTarget;
  behind?: PaneTarget;
}

/** An agent's page opens beside the focused chat, leaving its draft and cursor alone. */
export function revealBrowser(panes: Pane[], focused: number, key: number): Pane[] {
  if (panes.some((pane) => pane.target.kind === 'browser')) return panes;
  if (panes.length === 1)
    return [...panes, { key, target: { kind: 'browser' }, behind: { kind: 'list' } }];
  return panes.map((pane) =>
    pane.key === focused ? pane : { ...pane, target: { kind: 'browser' }, behind: pane.target },
  );
}

/** The app opens to Merv's thread. It begins on the list, which is all it has until the board beside it has a
 *  conversation; when that arrives the list gives way to the thread, unless the person has already gone somewhere. */
export function landOnMerv(panes: Pane[], moved: boolean, chat: unknown): Pane[] {
  if (moved || !(chat as { conversation?: string } | undefined)?.conversation) return panes;
  return panes.length === 1 && panes[0]!.target.kind === 'list'
    ? [{ ...panes[0]!, target: { kind: 'merv' } }]
    : panes;
}

export const replacePane = (panes: Pane[], focused: number, target: PaneTarget): Pane[] =>
  panes.map((pane) =>
    pane.key === focused
      ? { ...pane, target, behind: target.kind === 'browser' ? pane.target : undefined }
      : pane,
  );
export const closePane = (panes: Pane[], key: number) => panes.filter((pane) => pane.key !== key);
export function belowPane(first: Pane, target: PaneTarget, key: number): Pane[] {
  const top = target.asideOf
    ? { ...first, target: { kind: 'thread' as const, id: target.asideOf }, behind: undefined }
    : first;
  const movingBrowser = target.kind === 'browser' && top.target.kind === 'browser';
  return [
    movingBrowser ? { ...top, target: top.behind ?? { kind: 'list' }, behind: undefined } : top,
    { key, target, behind: target.kind === 'browser' ? { kind: 'list' } : undefined },
  ];
}

/** A session opens beside the project's main thread, which stays in view. `showing` is the session each pane has open
 *  now. With the main thread in view the other pane takes the session (a second pane opens if there is one only); with
 *  it out of view the first pane becomes the main thread and the session stands beside it. `focus` is the pane to be in. */
export function besidePanes(
  panes: Pane[],
  showing: (string | undefined)[],
  main: string,
  id: string,
  key: number,
): { panes: Pane[]; focus: number } {
  const target: PaneTarget = { kind: 'thread', id },
    mainAt = showing.indexOf(main),
    at = showing.indexOf(id);
  if (mainAt >= 0 && at >= 0) return { panes, focus: panes[at]!.key };
  if (mainAt >= 0 && panes.length > 1)
    return {
      panes: panes.map((pane, index) =>
        index === mainAt ? pane : { ...pane, target, behind: undefined },
      ),
      focus: panes[1 - mainAt]!.key,
    };
  const first =
    mainAt >= 0
      ? panes[0]!
      : { ...panes[0]!, target: { kind: 'thread' as const, id: main }, behind: undefined };
  const second =
    mainAt < 0 && panes[1] ? { ...panes[1], target, behind: undefined } : { key, target };
  return { panes: [first, second], focus: second.key };
}
/** A job's own page opens in the pane that has its main thread, else in the pane the person is in. */
export function jobPanes(
  panes: Pane[],
  showing: (string | undefined)[],
  main: string,
  job: string,
  focused: number,
): { panes: Pane[]; focus: number } {
  const at = showing.indexOf(main),
    key = at >= 0 ? panes[at]!.key : focused;
  return { panes: replacePane(panes, key, { kind: 'thread', id: main, job }), focus: key };
}
/** Ask for a job's own page, from anywhere: its row in the column, or its entry in the main thread. */
export const openJobPage = (main: string, job: string, device?: string) =>
  dispatchEvent(
    new CustomEvent('merv:open-job', { detail: { main, job, ...(device && { device }) } }),
  );
/** The main thread comes into view to be answered in: the pane that has it, else the pane the person is in. */
export function answerPanes(
  panes: Pane[],
  showing: (string | undefined)[],
  main: string,
  focused: number,
): { panes: Pane[]; focus: number } {
  const at = showing.indexOf(main);
  return at >= 0
    ? { panes, focus: panes[at]!.key }
    : { panes: replacePane(panes, focused, { kind: 'thread', id: main }), focus: focused };
}
