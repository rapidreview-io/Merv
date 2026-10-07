import { nativeMcpConnectionsSchema } from '@merv/contracts';
import type { NativeMcpConnection } from '@merv/sessions/types';
import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { inspect } from 'node:util';
import { z } from 'zod';
import { check, effectiveWorkspace, MervError, sessionSecretPattern } from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import { label, platformName } from '@merv/sessions/rules';
import { launcherOf } from './harness/index.js';
import {
  conversationIdPattern,
  maximumSkillEntries,
  sessionTokenVariable,
} from './harness/shared.js';

export { assignmentCodexHome } from './harness/codex.js';
export { conversationIdPattern, sessionTokenVariable };

const common = {
  name: z.string().regex(platformName),
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
      model: label.optional(),
      effort: label.optional(),
      /** Image-owned executable that drops to the assignment identity before starting Codex. */
      isolatedLauncher: z
        .string()
        .min(1)
        .max(4096)
        .refine((value) => isAbsolute(value) && !/[\0\r\n]/.test(value))
        .optional(),
      /** Isolated only: the model is called through Main's relay with the session bearer, so the
       *  machine holds no provider key, and its shell commands have the network. */
      hosted: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      harness: z.literal('claude'),
      model: label.optional(),
      effort: label.optional(),
      /** Further MCP servers beside Merv, each bearer named by the variable that holds it. */
      servers: z
        .array(
          z
            .object({
              name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
              url: z.string().url().max(2048),
              bearerEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
            })
            .strict(),
        )
        .max(4)
        .optional(),
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
/** Trusted machine configuration. Remote settings can only tune documented fields. */
export type RunnerProfile = z.infer<typeof profileSchema>;

export interface LaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
  /** In-memory spawn input. Never persist this object or copy it to a process ledger. */
  env: Record<string, string>;
  stdin: string;
  /** The bearers this launch carries, which no variable name reveals; the output never shows them. */
  secrets: string[];
  /** Claude only: what the runner writes to `shellEnvFile` for Claude Code to source before each
   *  Bash command, so that no shell command sees a bearer its MCP client reads. */
  shellEnv?: string;
}
export interface LaunchRequest {
  session: Session;
  /** What Sessions tells the worker of its lease (the attach reply); the launch adds its own. */
  prompt: string;
  secret: string;
  /** Session capability delivered privately for this hosted launch, never persisted. */
  hfToken?: string | null;
  hfEndpoint?: string;
  /** Issued for this assignment only; never sourced from reusable runner configuration. */
  connections?: NativeMcpConnection[];
  mcpUrl: string;
  /** An owned workspace prepared by the runner, not a path supplied by an agent. */
  cwd: string;
  /** Canonical SKILL.md paths collected before launch; preparation itself stays pure. */
  disabledSkillPaths?: string[];
  /** Claude only, required: a private runner-owned path for the launch's `shellEnv`. */
  shellEnvFile?: string;
  /** The conversation this launch continues, already restored where its harness finds it. */
  resume?: string;
}

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
  if (!parsed.success || !launcherOf(parsed.data).valid(parsed.data)) {
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

/**
 * A lease with nowhere to work. `readOnly` describes the RECORD — a reviewer writes its verdict
 * and nothing else — and that is no reason to take the machine away: a reviewer that cannot run
 * the script it is judging can only ever report that the script looks coherent. Scratch space
 * and a checkout that is discarded afterwards are both free to compute in; the workspace a
 * later launch inherits is not, because what is left behind would reach the next worker.
 */
export const sealed = (session: LaunchRequest['session']): boolean => {
  const workspace = effectiveWorkspace(session.execution.policy);
  return (
    session.execution.policy.readOnly &&
    ((workspace.mode !== 'none' && workspace.retain) || inquiring(session))
  );
};
/**
 * An inquiry visit (`session.inquiry`): a person's question to the agent, answered from its
 * restored conversation. It is sealed as a review of a retained checkout is: the filesystem
 * read-only (its directory may be the work's own, on a work host), no shell writes, no
 * connections, and nothing of it kept.
 */
export const inquiring = (session: LaunchRequest['session']): boolean =>
  !!(session as { inquiry?: unknown }).inquiry;

/** Deterministic environment names are local to one spawn, never persisted or global. */
const nativeServers = (request: LaunchRequest) =>
  (sealed(request.session) ? [] : (request.connections ?? [])).map((connection, index) => ({
    name: connection.name,
    url: connection.url,
    bearerEnv: `MERV_NATIVE_MCP_TOKEN_${index}`,
  }));

/** Whether a launch is given Merv's internet reads: only where its shell has the network already,
 * a hosted Codex launch or a Claude one, and never a sealed review. */
const internet = (profile: RunnerProfile, session: LaunchRequest['session']): boolean =>
  !sealed(session) && launcherOf(profile).networked(profile);

/**
 * What a launch is told of reads beyond the project, naming the internet reads only where it is
 * given them. Tool descriptions alone leave a worker answering from memory, since the rest of
 * this text speaks of project reads only; what each outside source is for, its tool says.
 */
const searching = (web: boolean): string =>
  `For what this project does not hold, use the tools you are listed for outside sources rather than your memory, and cite what you rely on as each tool's description says.${web ? ' web.search and web.extract find and read the public web.' : ''}`;

/** How long a launch whose own handoff closed its session may take to end by itself. */
export const handoffGraceMs = (profile: RunnerProfile) => launcherOf(profile).handoffGraceMs;

/** Pure launch preparation. The supervisor owns availability checks, spawning and teardown. */
export function buildLaunch(
  /** Validated where it is read: the local configuration or the launch's persisted profile. */
  profile: RunnerProfile,
  request: LaunchRequest,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): LaunchSpec {
  check(profile.enabled, 'runner_profile_disabled', 'Runner profile is disabled');
  const launcher = launcherOf(profile);
  check(
    sessionSecretPattern.test(request.secret),
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
    !!launcher.agent || !session.execution.policy.readOnly,
    'unsupported_read_only',
    'Command profiles have no filesystem sandbox and cannot execute read-only leases',
  );
  const parsedConnections = nativeMcpConnectionsSchema.safeParse(
    sealed(session) ? [] : (request.connections ?? []),
  );
  check(parsedConnections.success, 'invalid_runner_launch', 'Invalid private MCP connections');
  request = { ...request, connections: parsedConnections.data! };
  check(
    !!launcher.agent || request.connections!.length === 0,
    'invalid_runner_launch',
    'Command profiles cannot receive MCP connections',
  );
  check(
    request.resume === undefined ||
      (!!launcher.agent && conversationIdPattern.test(request.resume)),
    'invalid_runner_launch',
    'Only a Claude or Codex launch resumes, a conversation named by its UUID',
  );
  const url = endpoint(request.mcpUrl);
  const parts = launcher.launch(profile, {
    request,
    url,
    runtime: runtimeEnvironment(environment),
    environment,
    sealed: sealed(session),
    inquiry: inquiring(session),
    internet: internet(profile, session),
    servers: nativeServers(request),
  });
  const inquiry = inquiring(session);
  check(
    !inquiry || (request.resume !== undefined && !!launcher.agent),
    'invalid_runner_launch',
    'An inquiry visit runs only on the conversation it asks',
  );
  const stdin = [
    ...(request.resume
      ? [
          inquiry
            ? 'A person is asking you about your earlier work in this conversation. This is a short, read-only inquiry, not a return to the work: answer as the assignment below says, and stop.'
            : 'You are continuing your earlier work on this unit. Read the current assignment and its context sections: they supersede anything earlier in this conversation (earlier plans, inputs, or feedback you already addressed).',
        ]
      : []),
    request.prompt,
    ...(profile.harness === 'command' ? [] : [searching(internet(profile, session))]),
    ...(profile.harness === 'codex' &&
    profile.hosted &&
    !sealed(session) &&
    request.hfToken &&
    request.hfEndpoint
      ? [
          'Hugging Face downloads are available through HF_TOKEN and HF_ENDPOINT already in your environment. Use huggingface_hub, datasets, transformers or hf download normally; do not log in or print these variables. HF_TOKEN is a readable, read-only capability valid only during this session, not the account token. For SSH work, send both variables privately through stdin to the remote process; never put them in tool arguments, durable job commands, files, logs or artifacts. The next worker supplies its own access. Managed compute jobs do not yet receive HF access. Uploads, account settings and raw Git authentication are not supported by this broker.',
        ]
      : []),
    inquiry
      ? 'The local filesystem is read-only, and nothing you do here is kept: Merv’s read tools and your one reply are all this visit has.'
      : sealed(session)
        ? 'The checkout you were given is the thing under review and must be left exactly as you found it: the local filesystem is read-only. The MCP tools the assignment allows remain available.'
        : session.execution.policy.readOnly
          ? 'The workspace is yours to compute in. Run what you are judging rather than reading about it, and say in your handoff what you checked yourself and what you took on trust. Nothing you write there is recorded; your handoff is the only thing this lease writes.'
          : 'Use the provided workspace for local work. Preserve results through the tools specified by the assignment.',
    ...(parts.note && !inquiry ? [parts.note] : []),
    'Frozen assignment:',
    JSON.stringify(session.assignment),
    '',
  ].join('\n');
  // Bearers travel by name, from the runner's own environment, never as an argument.
  const bearers: Record<string, string> = { ...parts.bearers };
  for (const [index, connection] of (request.connections ?? []).entries())
    bearers[`MERV_NATIVE_MCP_TOKEN_${index}`] = connection.bearer;
  return protectLogging({
    executable: parts.executable,
    args: parts.args,
    cwd: request.cwd,
    stdin,
    secrets: Object.values(bearers),
    ...(parts.shellEnvFile && {
      shellEnv: `unset ${[sessionTokenVariable, ...Object.keys(bearers)].join(' ')}\n`,
    }),
    env: {
      ...parts.env,
      ...bearers,
      [mcpUrlVariable]: url,
      [sessionTokenVariable]: request.secret,
    },
  });
}
