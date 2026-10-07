import { lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize } from 'node:path';
import { check } from '@merv/contracts';
import { codexHandoffGraceMs } from '@merv/fleet/hosted-codex';
import { codexEvents } from '@merv/sessions/agent-stream';
import type { RunnerProfile } from '../profiles.js';
import {
  entries,
  firstId,
  type Harness,
  INTERNET_READS,
  type LaunchFacts,
  type Launcher,
  maximumSkillEntries,
  sessionTokenVariable,
  spent,
} from './shared.js';

type Codex = Extract<RunnerProfile, { harness: 'codex' }>;
/** The isolated assignment's Codex home, which the hosted image's launcher fixes. */
export const assignmentCodexHome = '/home/assignment/.codex';
/** The isolated assignment's own home; a local launch has one in its run directory. */
const home = (profile: RunnerProfile, runDirectory: string) =>
  profile.harness === 'codex' && profile.isolatedLauncher
    ? assignmentCodexHome
    : join(runDirectory, 'codex-home');

/**
 * Codex. `codex exec --json` runs one thread and ends each turn with `turn.completed`, whose
 * usage is the thread's running total (`input_tokens` includes cached input), so the last one
 * counts; a stream cut off before any turn completed reports nothing. It keeps each thread in its
 * home's databases too and resumes a thread only where it was recorded, so a local launch has a
 * home of its own, taken away whole when it ends; a conversation is a dated
 * `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl` there.
 */
export const codex: Harness = {
  name: 'codex',
  lines: codexEvents,
  usage: (output, model) => spent(output, 'turn.completed', model),
  conversationId: (output) =>
    firstId(
      output,
      '"thread.started"',
      (event) => event.type === 'thread.started' && event.thread_id,
    ),
  resumeRefused: /no rollout found/i,
  line: () => undefined,
  home,
  locate(root, id) {
    const walk = (directory: string, depth: number): string | undefined => {
      for (const entry of entries(directory)) {
        const path = join(directory, entry.name);
        if (depth < 3 && entry.isDirectory()) {
          const found = walk(path, depth + 1);
          if (found) return found;
        } else if (
          depth === 3 &&
          entry.name.startsWith('rollout-') &&
          entry.name.endsWith(`-${id}.jsonl`)
        )
          return path;
      }
      return undefined;
    };
    return walk(join(root, 'sessions'), 0);
  },
  restorePath(root, _cwd, id) {
    const now = new Date().toISOString();
    return [
      join(root, 'sessions', now.slice(0, 4), now.slice(5, 7), now.slice(8, 10)),
      `rollout-${now.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`,
    ];
  },
  forget: (root) => rmSync(root, { recursive: true, force: true }),
};

/** Before a local Codex launch: its own `CODEX_HOME`, holding a link to the machine's login. */
export function launchCodexHome(
  profile: RunnerProfile,
  runDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (profile.harness !== 'codex' || profile.isolatedLauncher) return undefined;
  const path = home(profile, runDirectory);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const login = join(path, 'auth.json');
  if (!lstatSync(login, { throwIfNoEntry: false }))
    symlinkSync(
      join(environment.CODEX_HOME ?? join(environment.HOME ?? homedir(), '.codex'), 'auth.json'),
      login,
    );
  return path;
}

/** JSON string escaping is valid for these TOML basic strings; no shell evaluates the result. */
const quote = (value: string): string => JSON.stringify(value);
const table = (values: Record<string, string>): string =>
  `{${Object.entries(values)
    .map(([key, value]) => `${quote(key)}=${quote(value)}`)
    .join(',')}}`;

function codexArgs(
  profile: Codex,
  { request, url, sealed, internet, servers }: LaunchFacts,
  safeEnvironment: Record<string, string>,
): string[] {
  const args = [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    // Only a session that may be continued keeps its conversation.
    ...(request.session.continuity ? [] : ['--ephemeral']),
    '--skip-git-repo-check',
    '--sandbox',
    sealed ? 'read-only' : 'workspace-write',
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
  // A model whose catalog entry names a multi-agent version (gpt-6.1-sol in Codex 0.160) gets
  // the spawn_agent tools whatever the features say; only this turns them off.
  config('agents.enabled', 'false');
  config('features.skip_host_skill_discovery', 'true');
  // A top-level key: Codex otherwise opens every stream with a warning about the feature above.
  config('suppress_unstable_features_warning', 'true');
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
  const hfShell = huggingface(profile, request, sealed);
  config('shell_environment_policy.inherit', quote(hfShell ? 'all' : 'none'));
  config('shell_environment_policy.ignore_default_excludes', hfShell ? 'true' : 'false');
  config('shell_environment_policy.experimental_use_profile', 'false');
  // MCP authentication reads the host process environment. Its bearer is deliberately
  // absent from the environment made available to model-generated shell commands.
  const shellEnvironment = { ...safeEnvironment };
  delete shellEnvironment.CODEX_HOME;
  delete shellEnvironment.CLAUDE_CONFIG_DIR;
  // Codex applies include_only after set; retain the safe override names as well.
  // Default exclusions remove *TOKEN*, so bypass them only behind this exact name list.
  if (hfShell)
    config(
      'shell_environment_policy.include_only',
      JSON.stringify([...Object.keys(shellEnvironment), 'HF_TOKEN', 'HF_ENDPOINT']),
    );
  config('shell_environment_policy.set', table(shellEnvironment));
  config('sandbox_workspace_write.writable_roots', '[]');
  // A hosted machine holds no provider key and the server caps its step, so its shell commands
  // may use the network, and it is given Merv's internet reads. Codex's own web search stays
  // disabled, and a sealed review stays read-only and offline.
  config('sandbox_workspace_write.network_access', profile.hosted ? 'true' : 'false');
  config('sandbox_workspace_write.exclude_tmpdir_env_var', 'true');
  config('sandbox_workspace_write.exclude_slash_tmp', 'true');
  // Codex sees what Merv's server lists to this session, as Claude does through the whole
  // mcp__merv prefix: every read in the project and the writes this lease was granted. Sessions
  // enforce the manifest and its argument bindings on every call, and a fixed list here hid the
  // project reads a worker's own brief named. Every listed tool runs unprompted, since nobody
  // answers a prompt under approval policy never; the internet reads stay off where the shell
  // has no network.
  const offline = internet ? '' : `,disabled_tools=${JSON.stringify(INTERNET_READS)}`;
  config(
    'mcp_servers',
    // The handshake waits behind the server's writer queue under load; Codex's default 30 s failed every review launch.
    // A call waits 60 s by default, and a web search can take 150 s (its turn, Tavily, then the
    // fallback): a worker that gave up would leave Merv finishing, and paying for, the call.
    `{merv={url=${quote(url)},bearer_token_env_var=${quote(sessionTokenVariable)},required=true,startup_timeout_sec=120,tool_timeout_sec=180,default_tools_approval_mode="approve"${offline}}${servers
      .map(
        (server) =>
          `,${server.name}={url=${quote(server.url)},bearer_token_env_var=${quote(server.bearerEnv)},required=true,startup_timeout_sec=120,tool_timeout_sec=180,default_tools_approval_mode="approve"}`,
      )
      .join('')}}`,
  );
  if (profile.model !== undefined) args.push('--model', profile.model);
  if (profile.effort !== undefined) config('model_reasoning_effort', quote(profile.effort));
  if (profile.hosted) {
    config('model_provider', quote('merv'));
    config(
      'model_providers.merv',
      table({
        name: 'Merv',
        base_url: `${new URL(url).origin}/codex-model`,
        env_key: sessionTokenVariable,
        wire_api: 'responses',
      }),
    );
  }
  // `exec resume` takes exec's own options before it and reads the next turn from stdin.
  args.push(...(request.resume ? ['resume', request.resume] : []), '-');
  return args;
}

/** Whether this launch's shell is given the session's Hugging Face access. */
const huggingface = (profile: Codex, request: LaunchFacts['request'], sealed: boolean) =>
  !!profile.hosted && !sealed && !!request.hfToken && !!request.hfEndpoint;

export const codexLauncher: Launcher<Codex> = {
  agent: codex,
  tuned: true,
  skills: true,
  // Codex writes a closing message after the handoff tool returns and prints its
  // `turn.completed` only then.
  handoffGraceMs: codexHandoffGraceMs,
  valid: (profile) =>
    profile.isolatedLauncher !== undefined ? isAbsolute(profile.executable) : !profile.hosted,
  isolated: (profile) => !!profile.isolatedLauncher,
  networked: (profile) => !!profile.hosted,
  huggingface: (profile) => !!profile.hosted,
  prepare: (profile, runDirectory, environment) =>
    profile.isolatedLauncher
      ? undefined
      : { CODEX_HOME: launchCodexHome(profile, runDirectory, environment)! },
  launch(profile, facts) {
    const { request, sealed } = facts;
    const env = profile.isolatedLauncher
      ? {
          PATH: '/usr/bin:/bin',
          HOME: '/home/assignment',
          CODEX_HOME: assignmentCodexHome,
          USER: 'assignment',
          TMPDIR: '/tmp',
          LANG: 'C.UTF-8',
        }
      : facts.runtime;
    const args = codexArgs(profile, facts, env);
    return {
      ...(profile.isolatedLauncher
        ? { executable: profile.isolatedLauncher, args: ['--', profile.executable, ...args] }
        : { executable: profile.executable, args }),
      env: {
        ...env,
        ...(huggingface(profile, request, sealed)
          ? { HF_TOKEN: request.hfToken!, HF_ENDPOINT: request.hfEndpoint! }
          : {}),
      },
    };
  },
};
