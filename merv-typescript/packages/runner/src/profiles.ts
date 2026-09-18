import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { inspect } from 'node:util';
import { z } from 'zod';
import { check, MervError } from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import type { RunnerProfile } from './types.js';
export type { RunnerProfile } from './types.js';

const text = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value && !/[\0\r\n]/.test(value));
const common = {
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/),
  executable: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !/[\0\r\n]/.test(value)),
  enabled: z.boolean(),
  parallelism: z.number().int().min(1).max(32),
};
const profileSchema = z.discriminatedUnion('harness', [
  z
    .object({
      ...common,
      harness: z.literal('codex'),
      model: text.optional(),
      effort: text.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      harness: z.literal('claude'),
      model: text.optional(),
      effort: text.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      harness: z.literal('command'),
      args: z
        .array(
          z
            .string()
            .max(32_768)
            .refine((value) => !value.includes('\0')),
        )
        .max(256)
        .optional(),
    })
    .strict(),
]);

export interface LaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
  /** In-memory spawn input. Never persist this object or copy it to a process ledger. */
  env: Record<string, string>;
  stdin: string;
}
export interface LaunchRequest {
  session: Session;
  secret: string;
  mcpUrl: string;
  /** An owned workspace prepared by the runner, not a path supplied by an agent. */
  cwd: string;
  /** Canonical SKILL.md paths collected before launch; preparation itself stays pure. */
  disabledSkillPaths?: string[];
}

const maximumSkillEntries = 4096;

/**
 * Codex discovers repository skills at cwd/.agents/skills and each ancestor's
 * .agents/skills through the nearest repository root, including linked worktrees.
 * Without a repository marker only cwd is a repository discovery location.
 * Host/admin/system skills are deliberately outside this repository scan.
 * Symlinks fail closed: Codex follows them, so ignoring them would miss instructions.
 */
export function collectRepositorySkillPaths(cwd: string): string[] {
  check(isAbsolute(cwd), 'invalid_runner_launch', 'Workspace must be an absolute path');
  const failure = () =>
    new MervError('unsafe_repository_skills', 'Repository skill discovery could not be isolated');
  try {
    const canonical = realpathSync(cwd);
    check(
      lstatSync(canonical).isDirectory(),
      'unsafe_repository_skills',
      'Workspace must be a directory',
    );
    const stat = (path: string) => {
      try {
        const value = lstatSync(path);
        if (value.isSymbolicLink()) throw failure();
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    };
    const ancestors: string[] = [];
    let directory = canonical;
    let repository = false;
    for (;;) {
      if (ancestors.length >= 128) throw failure();
      ancestors.push(directory);
      const marker = stat(join(directory, '.git'));
      if (marker) {
        if (!marker.isDirectory() && !marker.isFile()) throw failure();
        repository = true;
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    let entries = 0;
    const paths = new Set<string>();
    const scan = (path: string, depth: number) => {
      if (depth > 32) throw failure();
      const handle = opendirSync(path);
      try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          if (++entries > maximumSkillEntries || entry.isSymbolicLink()) throw failure();
          const child = join(path, entry.name);
          // Recheck the entry itself so a symlink replacement during discovery fails.
          const value = stat(child);
          if (!value) throw failure();
          if (value.isDirectory()) scan(child, depth + 1);
          else if (entry.name === 'SKILL.md') {
            if (!value.isFile() || realpathSync(child) !== child) throw failure();
            paths.add(child);
          }
        }
      } finally {
        handle.closeSync();
      }
    };
    for (const root of repository ? ancestors : [canonical]) {
      const agents = join(root, '.agents');
      const agentsStat = stat(agents);
      if (!agentsStat) continue;
      if (!agentsStat.isDirectory()) throw failure();
      const skills = join(agents, 'skills');
      const skillsStat = stat(skills);
      if (!skillsStat) continue;
      if (!skillsStat.isDirectory()) throw failure();
      scan(skills, 0);
    }
    return [...paths].sort();
  } catch (error) {
    if (error instanceof MervError) throw error;
    throw failure();
  }
}

export const sessionTokenVariable = 'MERV_AGENT_SESSION_TOKEN';
export const mcpUrlVariable = 'MERV_MCP_URL';
const runtimeVariables = [
  'PATH',
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'USER',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'CODEX_HOME',
] as const;

export function validateProfile(input: unknown): RunnerProfile {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) {
    // Do not echo local configuration values: a mistaken argument may contain a secret.
    throw new MervError('invalid_runner_profile', 'Invalid or unsupported runner profile');
  }
  return parsed.data;
}

function endpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MervError('invalid_runner_launch', 'MCP endpoint must be an absolute URL');
  }
  check(
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'invalid_runner_launch',
    'MCP endpoint requires HTTPS or loopback HTTP, without URL credentials, query or fragment',
  );
  return url.href;
}

function runtimeEnvironment(environment: Readonly<NodeJS.ProcessEnv>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of runtimeVariables) {
    const value = environment[key];
    if (value !== undefined && !value.includes('\0')) result[key] = value;
  }
  return result;
}

/** JSON string escaping is valid for these TOML basic strings; no shell evaluates the result. */
const quote = (value: string): string => JSON.stringify(value);
const table = (values: Record<string, string>): string =>
  `{${Object.entries(values)
    .map(([key, value]) => `${quote(key)}=${quote(value)}`)
    .join(',')}}`;

function codexArgs(
  profile: Extract<RunnerProfile, { harness: 'codex' }>,
  request: LaunchRequest,
  url: string,
  safeEnvironment: Record<string, string>,
): string[] {
  const tools = [...new Set(request.session.execution.policy.tools.map((tool) => tool.name))];
  check(
    tools.every((name) => /^[A-Za-z0-9_.-]{1,128}$/.test(name)),
    'invalid_runner_launch',
    'Invalid fixed tool manifest',
  );
  const args = [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    request.session.execution.policy.readOnly ? 'read-only' : 'workspace-write',
    '--json',
    '--color',
    'never',
    '-C',
    request.cwd,
  ];
  const config = (key: string, value: string) => args.push('-c', `${key}=${value}`);
  config('approval_policy', quote('never'));
  // Native shell remains available inside the declared filesystem sandbox. Unrelated
  // account integrations, hooks and agents must not broaden this lease's tool surface.
  for (const feature of [
    'apps',
    'plugins',
    'hooks',
    'remote_plugin',
    'multi_agent',
    'multi_agent_v2',
    'shell_snapshot',
    'tool_suggest',
    'skill_search',
    'skill_mcp_dependency_install',
    'browser_use',
    'browser_use_external',
    'computer_use',
    'image_generation',
    'in_app_local_automation',
  ])
    config(`features.${feature}`, 'false');
  config('features.skip_host_skill_discovery', 'true');
  const disabledSkills = request.disabledSkillPaths ?? [];
  check(
    Array.isArray(disabledSkills) &&
      disabledSkills.length <= maximumSkillEntries &&
      disabledSkills.every(
        (path) =>
          typeof path === 'string' &&
          path.length <= 4096 &&
          isAbsolute(path) &&
          normalize(path) === path &&
          basename(path) === 'SKILL.md' &&
          !/[\0\r\n]/.test(path),
      ),
    'invalid_runner_launch',
    'Disabled repository skills must be canonical SKILL.md paths',
  );
  // --ignore-rules and skip_host_skill_discovery do not suppress repo skills.
  // Installed Codex exec resolves these entries by the exact SKILL.md file path.
  config(
    'skills.config',
    `[${[...new Set(disabledSkills)]
      .sort()
      .map((path) => `{path=${quote(path)},enabled=false}`)
      .join(',')}]`,
  );
  config('features.shell_tool', 'true');
  config('web_search', quote('disabled'));
  config('project_doc_max_bytes', '0');
  config('allow_login_shell', 'false');
  config('shell_environment_policy.inherit', quote('none'));
  config('shell_environment_policy.ignore_default_excludes', 'false');
  config('shell_environment_policy.experimental_use_profile', 'false');
  // MCP authentication reads the host process environment. Its bearer is deliberately
  // absent from the environment made available to model-generated shell commands.
  const shellEnvironment = { ...safeEnvironment };
  delete shellEnvironment.CODEX_HOME;
  delete shellEnvironment.CLAUDE_CONFIG_DIR;
  config('shell_environment_policy.set', table(shellEnvironment));
  config('sandbox_workspace_write.writable_roots', '[]');
  config('sandbox_workspace_write.network_access', 'false');
  config('sandbox_workspace_write.exclude_tmpdir_env_var', 'true');
  config('sandbox_workspace_write.exclude_slash_tmp', 'true');
  const toolApprovals = `{${tools.map((name) => `${quote(name)}={approval_mode="approve"}`).join(',')}}`;
  // This is an allowlist, not just an approval preference. Sessions independently
  // enforce the same fixed manifest and argument bindings on every server call.
  config(
    'mcp_servers',
    // The handshake waits behind the server's writer queue under load; Codex's default 30 s failed every review launch.
    `{merv={url=${quote(url)},bearer_token_env_var=${quote(sessionTokenVariable)},required=true,startup_timeout_sec=120,enabled_tools=${JSON.stringify(tools)},tools=${toolApprovals}}}`,
  );
  if (profile.model !== undefined) args.push('--model', profile.model);
  if (profile.effort !== undefined) config('model_reasoning_effort', quote(profile.effort));
  args.push('-');
  return args;
}

/**
 * Claude Code headless. The same shape as the Codex launch: the Merv server alone, its
 * bearer read from the process environment and never from an argument, no user or
 * project settings, hooks, plugins or skills, and no permission prompts because there
 * is nobody to answer them. A read-only lease keeps only the read tools; the server
 * enforces the fixed manifest and argument bindings on every call either way.
 */
function claudeArgs(
  profile: Extract<RunnerProfile, { harness: 'claude' }>,
  request: LaunchRequest,
  url: string,
): string[] {
  const readOnly = request.session.execution.policy.readOnly;
  const builtIn = readOnly
    ? ['Read', 'Glob', 'Grep']
    : ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit'];
  return [
    '--print',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({
      mcpServers: {
        merv: {
          type: 'http',
          url,
          headers: { Authorization: `Bearer \${${sessionTokenVariable}}` },
        },
      },
    }),
    '--tools',
    builtIn.join(','),
    '--allowedTools',
    [...builtIn, 'mcp__merv'].join(','),
    '--dangerously-skip-permissions',
    '--model',
    profile.model ?? 'opus',
    ...(profile.effort !== undefined ? ['--effort', profile.effort] : []),
  ];
}

function protectLogging(spec: LaunchSpec): LaunchSpec {
  const safe = () => ({
    executable: spec.executable,
    args: spec.args,
    cwd: spec.cwd,
    env: Object.fromEntries(Object.keys(spec.env).map((key) => [key, '[redacted]'])),
    stdin: '[frozen assignment omitted]',
  });
  Object.defineProperty(spec, 'toJSON', { value: safe });
  Object.defineProperty(spec, inspect.custom, { value: safe });
  Object.defineProperty(spec.env, 'toJSON', {
    value: () => Object.fromEntries(Object.keys(spec.env).map((key) => [key, '[redacted]'])),
  });
  Object.defineProperty(spec.env, inspect.custom, {
    value: () => Object.fromEntries(Object.keys(spec.env).map((key) => [key, '[redacted]'])),
  });
  return spec;
}

/** Pure launch preparation. The supervisor owns availability checks, spawning and teardown. */
export function buildLaunch(
  profileInput: RunnerProfile,
  request: LaunchRequest,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): LaunchSpec {
  const profile = validateProfile(profileInput);
  check(profile.enabled, 'runner_profile_disabled', 'Runner profile is disabled');
  check(
    /^ms_[A-Za-z0-9_-]{43}$/.test(request.secret),
    'invalid_runner_launch',
    'A session credential is required',
  );
  check(
    isAbsolute(request.cwd) && !/[\0\r\n]/.test(request.cwd),
    'invalid_runner_launch',
    'Workspace must be an absolute path',
  );
  const { session } = request;
  check(
    session.status === 'offered' || session.status === 'active',
    'session_closed',
    'Cannot launch a closed session',
  );
  check(
    session.execution.instanceId === session.instanceId &&
      session.assignment.instanceId === session.instanceId &&
      session.execution.projectId === session.projectId &&
      session.assignment.projectId === session.projectId &&
      session.execution.actorId === session.actorId &&
      session.assignment.actorId === session.actorId &&
      session.execution.revision === session.expectedRevision &&
      session.assignment.revision === session.expectedRevision &&
      typeof session.execution.policy.readOnly === 'boolean' &&
      session.assignment.execution.readOnly === session.execution.policy.readOnly,
    'invalid_runner_launch',
    'Session assignment and fixed execution do not agree',
  );
  check(
    profile.harness !== 'command' || !session.execution.policy.readOnly,
    'unsupported_read_only',
    'Command profiles have no filesystem sandbox and cannot execute read-only leases',
  );
  const url = endpoint(request.mcpUrl);
  const safeEnvironment = runtimeEnvironment(environment);
  const args =
    profile.harness === 'codex'
      ? codexArgs(profile, request, url, safeEnvironment)
      : profile.harness === 'claude'
        ? claudeArgs(profile, request, url)
        : [...(profile.args ?? [])];
  const stdin = [
    'You are the worker for one Merv workflow step. The following assignment is frozen for this lease.',
    'Use the Merv MCP tools to inspect the assigned work, perform it, and follow its handoff instruction.',
    'Tool arguments are constrained by the server. Stop when the handoff completes or the lease/revision is no longer valid.',
    session.execution.policy.readOnly
      ? 'The local filesystem is read-only. Explicitly allowed MCP checkpoint and verdict operations remain available.'
      : 'Use the provided workspace for local work. Preserve results through the tools specified by the assignment.',
    'Frozen assignment:',
    JSON.stringify(session.assignment),
    '',
  ].join('\n');
  return protectLogging({
    executable: profile.executable,
    args,
    cwd: request.cwd,
    stdin,
    env: { ...safeEnvironment, [mcpUrlVariable]: url, [sessionTokenVariable]: request.secret },
  });
}
