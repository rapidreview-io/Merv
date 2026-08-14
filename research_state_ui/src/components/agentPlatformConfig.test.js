import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_WORKSPACE,
  PLATFORM_PRESETS,
  defaultWorktreeRoot,
  draftFromSettings,
  normalizeLocalPlatforms,
  workspaceWithRepository,
} from './agentPlatformConfig.js';

test('new workspaces use main as the base ref', () => {
  assert.equal(DEFAULT_WORKSPACE.base_ref, 'main');
  assert.equal(draftFromSettings({ agent_workspace: {} }).workspace.base_ref, 'main');
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

test('aider is absent from auto-run presets and old drafts', () => {
  assert.equal(PLATFORM_PRESETS.some((platform) => platform.id === 'aider'), false);
  assert.equal(
    normalizeLocalPlatforms([{ id: 'aider', adapter: 'aider', command: ['aider'] }])
      .some((platform) => platform.id === 'aider'),
    false,
  );
  assert.equal(
    draftFromSettings({
      agent_platforms: { aider: { adapter: 'aider', command: ['aider'] } },
    }).platforms.some((platform) => platform.id === 'aider'),
    false,
  );
});
