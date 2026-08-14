const ADAPTER_CAPABILITIES = {
  codex: { model: true, effort: true },
  claude: { model: true, effort: true },
  gemini: { model: true, effort: false },
  cursor: { model: true, effort: false },
  opencode: { model: true, effort: true },
  copilot: { model: true, effort: false },
  qwen: { model: true, effort: false },
  hermes: { model: true, effort: false },
  command: { model: true, effort: true },
};

export const ADAPTERS = Object.keys(ADAPTER_CAPABILITIES);

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
  adapter: id,
  command: [executable],
  model,
  effort,
  parallelism,
  enabled,
  present: true,
  custom: false,
}));

export const DEFAULT_WORKSPACE = {
  strategy: 'git_worktree',
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
  return PLATFORM_PRESETS.map((platform) => ({
    ...platform,
    command: [...platform.command],
  }));
}

function commandValue(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value) return [value];
  return [...fallback];
}

function configuredPlatform(id, raw, preset = null) {
  const commandWasString = typeof raw?.command === 'string'
    && /\s/.test(raw.command.trim());
  const hasCommand = raw && Object.hasOwn(raw, 'command');
  return {
    id,
    name: typeof raw?.name === 'string' && raw.name
      ? raw.name
      : (preset?.name || id),
    adapter: typeof raw?.adapter === 'string'
      ? raw.adapter
      : (preset?.adapter || id),
    command: commandValue(
      hasCommand ? raw.command : undefined,
      hasCommand ? [] : (preset?.command || [id]),
    ),
    model: typeof raw?.model === 'string' ? raw.model : '',
    effort: typeof raw?.effort === 'string' ? raw.effort : '',
    parallelism: raw?.parallelism ?? 1,
    enabled: raw?.enabled !== false,
    present: true,
    custom: !preset,
    commandWasString,
  };
}

function supportedPlatform(id, raw) {
  return String(id || '').toLowerCase() !== 'aider'
    && String(raw?.adapter || '').toLowerCase() !== 'aider';
}

export function normalizeLocalPlatforms(saved) {
  if (!Array.isArray(saved) || !saved.length) return defaultPlatforms();
  const presets = new Map(PLATFORM_PRESETS.map((item) => [item.id, item]));
  const normalized = saved
    .filter((item) => (
      item
      && typeof item.id === 'string'
      && item.id
      && supportedPlatform(item.id, item)
    ))
    .map((item) => ({
      ...configuredPlatform(item.id, item, presets.get(item.id)),
      present: item.present !== false,
    }));
  const ids = new Set(normalized.map((item) => item.id));
  return [
    ...normalized,
    ...PLATFORM_PRESETS
      .filter((item) => !ids.has(item.id))
      .map((item) => ({ ...item, command: [...item.command] })),
  ];
}

export function draftFromSettings(settings) {
  const configured = settings?.agent_platforms;
  const values = configured && typeof configured === 'object' && !Array.isArray(configured)
    ? configured
    : {};
  const presets = new Map(PLATFORM_PRESETS.map((item) => [item.id, item]));
  const platforms = PLATFORM_PRESETS.map((preset) => (
    Object.hasOwn(values, preset.id)
      ? configuredPlatform(preset.id, values[preset.id], preset)
      : {
        ...preset,
        command: [...preset.command],
        enabled: false,
        present: false,
      }
  ));
  for (const [id, raw] of Object.entries(values)) {
    if (!presets.has(id) && supportedPlatform(id, raw)) {
      platforms.push(configuredPlatform(id, raw));
    }
  }

  const rawWorkspace = settings?.agent_workspace;
  const workspace = rawWorkspace && typeof rawWorkspace === 'object'
    ? {
      ...DEFAULT_WORKSPACE,
      repository: typeof rawWorkspace.repository === 'string' ? rawWorkspace.repository : '',
      root: typeof rawWorkspace.root === 'string' ? rawWorkspace.root : '',
      base_ref: typeof rawWorkspace.base_ref === 'string' && rawWorkspace.base_ref.trim()
        ? rawWorkspace.base_ref
        : DEFAULT_WORKSPACE.base_ref,
    }
    : { ...DEFAULT_WORKSPACE };
  return { platforms, workspace };
}

export function configFromDraft(platforms, workspace) {
  return {
    agent_workspace: {
      strategy: 'git_worktree',
      repository: workspace.repository.trim(),
      root: workspace.root.trim(),
      base_ref: workspace.base_ref.trim(),
    },
    agent_platforms: Object.fromEntries(
      platforms
        .filter((platform) => platform.present !== false)
        .map((platform) => [
          platform.id,
          {
            adapter: platform.adapter.trim(),
            enabled: platform.enabled,
            command: [...platform.command],
            model: platform.model.trim() || null,
            effort: platform.effort.trim() || null,
            parallelism: Number(platform.parallelism),
          },
        ]),
    ),
  };
}

function absolutePath(value) {
  return value.startsWith('/')
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
  for (const platform of platforms.filter((item) => item.present !== false || item.enabled)) {
    const errors = {};
    if (!ADAPTERS.includes(platform.adapter.trim())) {
      errors.adapter = `Choose one of: ${ADAPTERS.join(', ')}.`;
    }
    const parallelism = Number(platform.parallelism);
    if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 32) {
      errors.parallelism = 'Parallelism must be an integer from 1 to 32.';
    }
    if (platform.enabled) {
      if (
        !Array.isArray(platform.command)
        || !platform.command.length
        || platform.command.some((argument) => typeof argument !== 'string' || !argument.trim())
      ) {
        errors.command = 'Enabled agents need one non-empty command argument per line.';
      } else if (platform.commandWasString) {
        errors.command = 'This older command draft is ambiguous. Re-enter one argument per line.';
      }
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

export function configSignature(config) {
  return JSON.stringify(config);
}

export function nextCustomId(platforms) {
  let n = 1;
  const used = new Set(platforms.map((platform) => platform.id));
  while (used.has(`agent-${n}`)) n += 1;
  return `agent-${n}`;
}
