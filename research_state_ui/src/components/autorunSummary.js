// The ambient auto-run summary the sidebar link and the Home strip read.
// Pure and dependency-light so it can be unit-tested with node:test.
import { runnerPresentation } from './runnerPresentation.js';

const EMPTY = Object.freeze([]);

function isLive(session) {
  return session?.status === 'offered' || session?.status === 'active';
}

export function summarize({ runners = EMPTY, sessions = EMPTY, fetchedAt = 0, now = Date.now() }) {
  const views = runners.map((runner) => runnerPresentation(runner, now));
  const live = views.filter((view) => view.live);
  const running = sessions.filter(isLive).length;
  const primary = live[0] || views[0] || null;
  return {
    known: fetchedAt > 0,
    runnerCount: runners.length,
    liveRunnerCount: live.length,
    running,
    machineName: primary?.machineName || '',
    tone: live.length ? 'live' : (views.length ? views[0].tone : 'off'),
    state: live.length ? 'Live' : (views[0]?.state || 'Not connected'),
    capacity: runners
      .filter((_, index) => views[index]?.live)
      .reduce((total, runner) => total + (Number(runner.capacity) || 0), 0),
  };
}
