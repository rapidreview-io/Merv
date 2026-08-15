import assert from 'node:assert/strict';
import test from 'node:test';

import { agentStages, stagesSummary } from './agentStages.js';

const NOW = Date.parse('2026-08-15T12:00:00Z');
const ready = { tag: 'ready', tone: 'ok', details: [], problems: [] };
const byKey = (stages) => Object.fromEntries(stages.map((s) => [s.key, s]));

test('a fully proven agent reads ok on every stage', () => {
  const entry = {
    executable: '/opt/homebrew/bin/codex', version: '0.9.1', merv_mcp: 'native', skills: 'mounted',
    auth: { status: 'present', via: '~/.codex/auth.json' },
    smoke: { status: 'ok', at: '2026-08-15T11:58:00Z', duration_ms: 4100 },
  };
  const stages = agentStages({ entry, readiness: ready, enabled: true, now: NOW });
  assert.deepEqual(stages.map((s) => [s.key, s.state]), [['installed', 'ok'], ['auth', 'ok'], ['skills', 'ok'], ['smoke', 'ok']]);
  assert.equal(byKey(stages).smoke.detail, 'passed 2m ago in 4.1 s');
  assert.equal(stagesSummary(stages), 'ok');
});

test('no sign-in signal is unknown, never a failure; the test call decides', () => {
  const entry = { executable: '/usr/local/bin/claude', version: '1.2.0', merv_mcp: 'native', skills: 'mounted', auth: { status: 'unknown' } };
  const stages = byKey(agentStages({ entry, readiness: ready, now: NOW }));
  assert.equal(stages.auth.state, 'unknown');
  assert.equal(stages.smoke.state, 'unknown');
  assert.equal(stages.smoke.detail, 'not run yet');
});

test('evidence from a failed launch or test names the fix in the harness terms', () => {
  const entry = {
    executable: '/opt/homebrew/bin/codex', version: '0.9.1', merv_mcp: 'native', skills: 'mounted',
    auth: { status: 'failed', line: 'Error: not logged in', detail: 'run `codex login` on this machine' },
    smoke: { status: 'failed', at: '2026-08-15T11:59:30Z', detail: 'Error: not logged in — run `codex login` on this machine' },
  };
  const stages = byKey(agentStages({ entry, readiness: ready, now: NOW }));
  assert.equal(stages.auth.state, 'fail');
  assert.equal(stages.auth.hint, 'run `codex login` on this machine');
  assert.equal(stages.smoke.state, 'fail');
  assert.equal(stagesSummary(Object.values(stages)), 'fail');
});

test('a running or queued test call shows as in progress', () => {
  const base = { executable: '/x/codex', version: '1', merv_mcp: 'native', skills: 'mounted', auth: { status: 'present', via: 'env OPENAI_API_KEY' } };
  const running = byKey(agentStages({ entry: { ...base, smoke: { status: 'running', why: 'requested' } }, readiness: ready, now: NOW }));
  assert.equal(running.smoke.state, 'running');
  assert.match(running.smoke.detail, /running \(requested\)/);
  const queued = byKey(agentStages({ entry: { ...base, smoke: { status: 'queued' } }, readiness: ready, now: NOW }));
  assert.equal(queued.smoke.state, 'running');
  assert.equal(stagesSummary(Object.values(queued)), 'running');
});

test('a missing executable fails the first stage and parks the rest', () => {
  const stages = byKey(agentStages({ entry: null, readiness: { tag: 'not found', tone: 'missing', details: [], problems: ["'gemini' is not on PATH"] }, now: NOW }));
  assert.equal(stages.installed.state, 'fail');
  assert.equal(stages.auth.state, 'pending');
  assert.equal(stages.smoke.state, 'pending');
});

test('a disabled agent explains why the test call is parked', () => {
  const entry = { executable: '/x/codex', version: '1', merv_mcp: 'native', skills: 'mounted', auth: { status: 'unknown' } };
  const stages = byKey(agentStages({ entry, readiness: ready, enabled: false, now: NOW }));
  assert.equal(stages.smoke.state, 'pending');
  assert.equal(stages.smoke.detail, 'enable the agent to test it');
});

test('the runner reporting no executable is an install failure, whatever the tag says', () => {
  const entry = { adapter: 'gemini', executable: '', version: '', ok: false, problems: ["'gemini' is not on PATH"], auth: { status: 'unknown' } };
  const stages = byKey(agentStages({ entry, readiness: { tag: 'not ready', tone: 'warn', details: [], problems: ["'gemini' is not on PATH"] }, now: NOW }));
  assert.equal(stages.installed.state, 'fail');
  assert.equal(stages.installed.detail, "'gemini' is not on PATH");
  assert.equal(stages.skills.state, 'pending');
  assert.equal(stages.smoke.state, 'pending');
});

test('a passed test call proves sign-in even when no signal was found', () => {
  const entry = { executable: '/x/claude', version: '1', merv_mcp: 'native', skills: 'mounted', auth: { status: 'unknown' }, smoke: { status: 'ok', at: '2026-08-15T11:59:00Z', duration_ms: 3000 } };
  const stages = byKey(agentStages({ entry, readiness: ready, now: NOW }));
  assert.equal(stages.auth.state, 'ok');
  assert.equal(stages.auth.detail, 'proven by the test call');
  assert.equal(stagesSummary(Object.values(stages)), 'ok');
});
