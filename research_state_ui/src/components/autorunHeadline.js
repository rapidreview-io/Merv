// The one sentence at the top of the Auto-run page: is the project's work
// moving on its own right now, and if not, why not. Pure so every state has a
// unit test and the page never has to reason about it in JSX.
import { runnerPresentation } from './runnerPresentation.js';

const EMPTY = Object.freeze([]);

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function isLive(session) {
  return session?.status === 'offered' || session?.status === 'active';
}

/**
 * @param {object} state
 * @param {boolean|null} state.dispatch  null while unknown
 * @param {Array} state.runners           brain runner rows
 * @param {Array} state.sessions          brain session rows
 * @param {number|null} state.waiting     dispatch-queue length, null when unknown (P1)
 * @param {number} state.now
 * @returns {{ text: string, tone: 'live'|'off'|'warning'|'error'|'quiet'|'' }}
 */
export function autorunHeadline({
  dispatch = null,
  runners = EMPTY,
  sessions = EMPTY,
  waiting = null,
  now = Date.now(),
} = {}) {
  const views = runners.map((runner) => runnerPresentation(runner, now));
  const live = views.filter((view) => view.live);
  const running = sessions.filter(isLive).length;
  const rejected = views.find((view) => view.settingsTone === 'error');
  const attention = rejected
    ? ` ${rejected.machineName} rejected its settings — open the machine to fix them.`
    : '';

  if (runners.length === 0) {
    return { text: 'No machine paired yet — pair one below to let agents pick up work.', tone: 'quiet' };
  }
  if (dispatch === null) {
    return { text: '', tone: '' };
  }
  if (dispatch === false) {
    const tail = running > 0
      ? `${plural(running, 'job')} still running; nothing new will start.`
      : 'nothing will start until it is on.';
    return { text: `Dispatch is off — ${tail}${attention}`, tone: 'off' };
  }
  if (live.length === 0) {
    const where = runners.length === 1 ? ` on ${views[0].machineName}` : '';
    const queue = waiting ? ` · ${plural(waiting, 'item')} waiting` : '';
    return {
      text: `No machine is live${queue} — start the runner${where}.${attention}`,
      tone: 'warning',
    };
  }
  const machines = plural(live.length, 'live machine');
  if (running > 0) {
    const queue = waiting ? ` · ${waiting} waiting` : '';
    return { text: `Dispatching to ${machines} · ${running} running${queue}.${attention}`, tone: 'live' };
  }
  if (waiting) {
    return { text: `${machines} · ${plural(waiting, 'item')} waiting to start.${attention}`, tone: 'live' };
  }
  const idle = waiting === 0
    ? 'nothing to run right now — no experiment is awaiting an agent.'
    : 'idle.';
  return { text: `${machines} · ${idle}${attention}`, tone: rejected ? 'error' : 'live' };
}
