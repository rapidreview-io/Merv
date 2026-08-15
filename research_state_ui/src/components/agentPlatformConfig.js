// The Auto-run settings form model. A draft is what the owner is editing for
// one paired runner: per native platform, the four tuning fields the brain may
// hold (enabled, model, effort, parallelism), plus the workspace paths. It is
// seeded from that runner's row — the owner's last saved settings when there
// are any, otherwise what the machine reported it has — and saved back through
// the brain, which the runner pulls on its next heartbeat. Executable commands
// and custom command-adapter agents are machine-local and never appear here.

const ADAPTER_CAPABILITIES = {
  codex: { model: true, effort: true },
  claude: { model: true, effort: true },
  gemini: { model: true, effort: false },
  cursor: { model: true, effort: false },
  opencode: { model: true, effort: true },
  copilot: { model: true, effort: false },
  qwen: { model: true, effort: false },
  hermes: { model: true, effort: false },
};

export const NATIVE_ADAPTERS = Object.keys(ADAPTER_CAPABILITIES);

export const PLATFORM_PRESETS = [
  ['codex', 'Codex', 'codex', 'gpt-5.6-sol', 'high', 2, true],
  ['claude', 'Claude Code', 'claude', 'opus', 'high', 2, true],
  ['gemini', 'Gemini CLI', 'gemini', '', '', 1, false],
  ['cursor', 'Cursor Agent', 'cursor-agent', '', '', 1, false],
  ['opencode', 'OpenCode', 'opencode', '', '', 1, false],
  ['copilot', 'GitHub Copilot CLI', 'copilot', '', '', 1, false],
  ['qwen', 'Qwen Code', 'qwen', '', '', 1, false],
  ['hermes', 'Hermes Agent', 'hermes', '', '', 1, false],
].map(([id, name, executable, model, effort, parallelism, enabled]) => ({
  id,
  name,
  executable,
  model,
  effort,
  parallelism,
  enabled,
}));

export const DEFAULT_WORKSPACE = {
  repository: '',
  root: '',
  base_ref: 'main',
};

export function defaultWorktreeRoot(repository) {
  const value = String(repository || '').trim();
  if (!value) return '';

  // Keep Merv's generated repository and worktrees beside the source checkout.
  // Putting them inside the checkout would make the source repository dirty.
  const withoutTrailingSeparators = value.replace(/[\\/]+$/, '');
  if (!withoutTrailingSeparators) return '/merv-worktrees';
  if (/^[A-Za-z]:$/.test(withoutTrailingSeparators)) {
    return `${withoutTrailingSeparators}\\merv-worktrees`;
  }
  return `${withoutTrailingSeparators}-worktrees`;
}

export function workspaceWithRepository(workspace, repository) {
  const currentDefault = defaultWorktreeRoot(workspace.repository);
  const rootWasAutomatic = !workspace.root.trim() || workspace.root.trim() === currentDefault;
  return {
    ...workspace,
    repository,
    root: rootWasAutomatic ? defaultWorktreeRoot(repository) : workspace.root,
  };
}

export function capabilitiesFor(adapter) {
  return ADAPTER_CAPABILITIES[adapter] || { model: false, effort: false };
}

export function defaultPlatforms() {
  return PLATFORM_PRESETS.map((platform) => ({ ...platform }));
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function parallelismValue(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 32 ? parsed : fallback;
}

// Seed a draft for one runner row. Precedence per platform: the owner's saved
// desired settings, then the machine's reported inventory, then the preset.
export function draftFromRunner(runner) {
  const desiredPlatforms = runner?.desired_settings?.platforms || {};
  const reported = new Map(
    (Array.isArray(runner?.platforms) ? runner.platforms : [])
      .filter((item) => item && typeof item.name === 'string')
      .map((item) => [item.name, item]),
  );
  const platforms = PLATFORM_PRESETS.map((preset) => {
    const saved = desiredPlatforms[preset.id];
    const seen = reported.get(preset.id);
    const source = saved || seen || null;
    return {
      ...preset,
      enabled: source && typeof source.enabled === 'boolean'
        ? source.enabled
        : (seen ? seen.enabled !== false : false),
      model: source ? text(source.model) : preset.model,
      effort: source ? text(source.effort) : preset.effort,
      parallelism: parallelismValue(source?.parallelism, preset.parallelism),
      // Present on the machine already (any state) vs. never configured there.
      configured: Boolean(seen),
    };
  });
  const custom = [...reported.values()]
    .filter((item) => item.managed === false)
    .map((item) => ({
      id: item.name,
      name: item.name,
      harness: item.harness || 'command',
      enabled: item.enabled !== false,
      parallelism: parallelismValue(item.parallelism, 1),
    }));

  const desiredWorkspace = runner?.desired_settings?.workspace || null;
  const reportedWorkspace = runner?.inventory?.workspace || null;
  const source = desiredWorkspace || reportedWorkspace || {};
  const workspace = {
    ...DEFAULT_WORKSPACE,
    repository: text(source.repository),
    root: text(source.root),
    base_ref: text(source.base_ref).trim() || DEFAULT_WORKSPACE.base_ref,
  };
  return { platforms, custom, workspace };
}

// The closed-schema payload PUT to the brain. Always the full native set the
// form knows about, so a toggle off is an explicit enabled:false, not an
// omission; the runner treats absence as "no change".
export function settingsFromDraft(platforms, workspace) {
  return {
    platforms: Object.fromEntries(platforms.map((platform) => [
      platform.id,
      {
        enabled: Boolean(platform.enabled),
        model: platform.model.trim(),
        effort: platform.effort.trim(),
        parallelism: Number(platform.parallelism),
      },
    ])),
    workspace: {
      repository: workspace.repository.trim(),
      root: workspace.root.trim(),
      base_ref: workspace.base_ref.trim(),
    },
  };
}

function absolutePath(value) {
  return value.startsWith('/')
    || value.startsWith('~')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('\\\\');
}

export function validateDraft(platforms, workspace) {
  const workspaceErrors = {};
  const repository = workspace.repository.trim();
  const root = workspace.root.trim();
  if (!repository) workspaceErrors.repository = 'Repository is required.';
  else if (!absolutePath(repository)) workspaceErrors.repository = 'Use an absolute repository path.';
  if (!root) workspaceErrors.root = 'Worktree root is required.';
  else if (!absolutePath(root)) workspaceErrors.root = 'Use an absolute worktree path.';
  if (!workspace.base_ref.trim()) workspaceErrors.base_ref = 'Base ref is required.';

  const platformErrors = {};
  for (const platform of platforms) {
    const errors = {};
    const parallelism = Number(platform.parallelism);
    if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 32) {
      errors.parallelism = 'Parallelism must be an integer from 1 to 32.';
    }
    if (Object.keys(errors).length) platformErrors[platform.id] = errors;
  }

  const messages = [
    ...Object.values(workspaceErrors),
    ...Object.values(platformErrors).flatMap((errors) => Object.values(errors)),
  ];
  return {
    valid: messages.length === 0,
    messages,
    workspace: workspaceErrors,
    platforms: platformErrors,
  };
}

export function draftSignature(platforms, workspace) {
  return JSON.stringify(settingsFromDraft(platforms, workspace));
}

// What the machine reported about one harness, folded into a tag + a detail
// line. `harness` is runner.inventory.harness (per-platform readiness the
// runner computes locally: executable, version, how it reaches Merv tools and
// skills, and any problems). Falls back to the plain executable probe.
export function readinessFor(platformId, executable, harness, availableCommands) {
  const entry = harness?.platforms?.[platformId];
  if (entry) {
    const details = [
      entry.version ? `v${String(entry.version).replace(/^v/i, '')}` : '',
      entry.merv_mcp === 'native' ? 'MCP native' : entry.merv_mcp === 'merv-client' ? 'MCP via merv-client' : '',
      entry.skills === 'mounted' ? 'skills mounted' : entry.skills === 'instruction' ? 'skills by instruction' : '',
    ].filter(Boolean);
    const problems = Array.isArray(entry.problems) ? entry.problems.filter(Boolean) : [];
    // Evidence outranks the static probe: a refused sign-in or a failed test
    // call is what the tag says; a passed test call is the strongest word.
    if (entry.auth?.status === 'failed') return { tag: 'not signed in', tone: 'warn', details, problems: [entry.auth.detail || 'sign in on the machine'].concat(problems) };
    if (entry.smoke?.status === 'failed') return { tag: 'test failed', tone: 'warn', details, problems: [entry.smoke.detail || 'the test call failed'].concat(problems) };
    if (entry.ok && entry.smoke?.status === 'ok') return { tag: 'verified', tone: 'ok', details, problems: [] };
    if (entry.ok) return { tag: 'ready', tone: 'ok', details, problems: [] };
    const missing = problems.some((text) => /not found|missing|no such|not installed/i.test(String(text)));
    return { tag: missing ? 'not found' : 'not ready', tone: missing ? 'missing' : 'warn', details, problems };
  }
  const found = availableCommands ? availableCommands[executable] : undefined;
  if (found === true) return { tag: 'installed', tone: 'ok', details: [], problems: [] };
  if (found === false) return { tag: 'not found', tone: 'missing', details: [], problems: [] };
  return { tag: '', tone: '', details: [], problems: [] };
}
