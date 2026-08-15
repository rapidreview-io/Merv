import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_WORKSPACE,
  PLATFORM_PRESETS,
  defaultWorktreeRoot,
  draftFromRunner,
  readinessFor,
  settingsFromDraft,
  validateDraft,
  workspaceWithRepository,
} from './agentPlatformConfig.js';

test('new workspaces use main as the base ref', () => {
  assert.equal(DEFAULT_WORKSPACE.base_ref, 'main');
  assert.equal(draftFromRunner(null).workspace.base_ref, 'main');
});

test('a repository gets a safe sibling worktree root', () => {
  const repository = '/Users/me/projects/prostate cancer';
  assert.equal(defaultWorktreeRoot(repository), `${repository}-worktrees`);
  assert.equal(
    workspaceWithRepository({ ...DEFAULT_WORKSPACE }, repository).root,
    `${repository}-worktrees`,
  );
});

test('the automatic root follows repository edits but a custom root is preserved', () => {
  const automatic = workspaceWithRepository(
    { ...DEFAULT_WORKSPACE, repository: '/projects/old', root: '/projects/old-worktrees' },
    '/projects/new',
  );
  assert.equal(automatic.root, '/projects/new-worktrees');

  const custom = workspaceWithRepository(
    { ...DEFAULT_WORKSPACE, repository: '/projects/old', root: '/scratch/merv' },
    '/projects/new',
  );
  assert.equal(custom.root, '/scratch/merv');
});

test('windows repository paths get a windows sibling root', () => {
  assert.equal(defaultWorktreeRoot('C:\\projects\\repo\\'), 'C:\\projects\\repo-worktrees');
});

test('aider is absent from auto-run presets and only native platforms are tunable', () => {
  assert.equal(PLATFORM_PRESETS.some((platform) => platform.id === 'aider'), false);
  const draft = draftFromRunner({
    platforms: [{ name: 'aider', harness: 'aider', enabled: true, managed: true }],
  });
  assert.equal(draft.platforms.some((platform) => platform.id === 'aider'), false);
});

test('a draft prefers saved settings, then the machine inventory, then presets', () => {
  const runner = {
    desired_settings: {
      platforms: { codex: { enabled: true, model: 'gpt-saved', effort: 'medium', parallelism: 3 } },
      workspace: { repository: '/srv/repo', root: '/srv/repo-worktrees', base_ref: 'dev' },
    },
    platforms: [
      { name: 'codex', harness: 'codex', enabled: false, model: 'gpt-machine', parallelism: 1, managed: true },
      { name: 'claude', harness: 'claude', enabled: true, model: 'opus', parallelism: 2, managed: true },
      { name: 'agent-1', harness: 'command', enabled: true, parallelism: 1, managed: false },
    ],
    inventory: { workspace: { repository: '/machine/repo' } },
  };
  const draft = draftFromRunner(runner);
  const codex = draft.platforms.find((item) => item.id === 'codex');
  const claude = draft.platforms.find((item) => item.id === 'claude');
  const gemini = draft.platforms.find((item) => item.id === 'gemini');
  assert.deepEqual(
    [codex.enabled, codex.model, codex.effort, codex.parallelism, codex.configured],
    [true, 'gpt-saved', 'medium', 3, true],
  );
  assert.deepEqual([claude.enabled, claude.model, claude.parallelism, claude.configured], [true, 'opus', 2, true]);
  assert.deepEqual([gemini.enabled, gemini.model, gemini.configured], [false, '', false]);
  assert.deepEqual(draft.custom, [{ id: 'agent-1', name: 'agent-1', harness: 'command', enabled: true, parallelism: 1 }]);
  assert.deepEqual(draft.workspace, { repository: '/srv/repo', root: '/srv/repo-worktrees', base_ref: 'dev' });
});

test('the saved payload is the closed schema with the full native set', () => {
  const draft = draftFromRunner(null);
  const platforms = draft.platforms.map((platform) => ({
    ...platform,
    enabled: platform.id === 'codex',
    model: platform.id === 'codex' ? 'gpt-tuned' : platform.model,
    effort: platform.id === 'codex' ? 'medium' : platform.effort,
  }));
  const settings = settingsFromDraft(platforms, {
    ...DEFAULT_WORKSPACE,
    repository: '/projects/repo',
    root: '/projects/repo-worktrees',
  });
  assert.deepEqual(Object.keys(settings), ['platforms', 'workspace']);
  assert.deepEqual(Object.keys(settings.platforms).sort(), PLATFORM_PRESETS.map((item) => item.id).sort());
  assert.deepEqual(settings.platforms.codex, { enabled: true, model: 'gpt-tuned', effort: 'medium', parallelism: 2 });
  assert.equal(settings.platforms.claude.enabled, false);
  for (const entry of Object.values(settings.platforms)) {
    assert.deepEqual(Object.keys(entry).sort(), ['effort', 'enabled', 'model', 'parallelism']);
  }
  assert.deepEqual(settings.workspace, { repository: '/projects/repo', root: '/projects/repo-worktrees', base_ref: 'main' });
});

test('validation requires absolute workspace paths and sane parallelism', () => {
  const draft = draftFromRunner(null);
  const bad = validateDraft(
    draft.platforms.map((item) => (item.id === 'codex' ? { ...item, parallelism: 99 } : item)),
    { repository: 'relative/repo', root: '', base_ref: '' },
  );
  assert.equal(bad.valid, false);
  assert.equal(bad.workspace.repository, 'Use an absolute repository path.');
  assert.equal(bad.workspace.root, 'Worktree root is required.');
  assert.equal(bad.workspace.base_ref, 'Base ref is required.');
  assert.equal(bad.platforms.codex.parallelism, 'Parallelism must be an integer from 1 to 32.');
  const good = validateDraft(draft.platforms, { repository: '~/repo', root: '/tmp/wt', base_ref: 'main' });
  assert.equal(good.valid, true);
});

test('harness readiness beats the plain executable probe and explains problems', () => {
  const harness = {
    skills: { count: 12, digest: 'abcdef1234' },
    platforms: {
      codex: { ok: true, executable: '/opt/codex', version: '0.9.1', merv_mcp: 'native', skills: 'mounted' },
      claude: { ok: false, version: 'v1.2', merv_mcp: 'native', skills: 'mounted', problems: ['claude: MCP config flag unsupported'] },
      gemini: { ok: false, problems: ['gemini: executable not found on PATH'] },
    },
  };
  const commands = { codex: true, claude: true, gemini: false, hermes: true };
  assert.deepEqual(readinessFor('codex', 'codex', harness, commands), {
    tag: 'ready', tone: 'ok', details: ['v0.9.1', 'MCP native', 'skills mounted'], problems: [],
  });
  const claude = readinessFor('claude', 'claude', harness, commands);
  assert.equal(claude.tag, 'not ready');
  assert.equal(claude.tone, 'warn');
  assert.deepEqual(claude.problems, ['claude: MCP config flag unsupported']);
  assert.equal(readinessFor('gemini', 'gemini', harness, commands).tag, 'not found');
  // No harness entry → fall back to the executable probe.
  assert.equal(readinessFor('hermes', 'hermes', harness, commands).tag, 'installed');
  assert.equal(readinessFor('qwen', 'qwen', null, commands).tag, '');
});
