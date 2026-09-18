import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Session } from '@merv/sessions/types';
import {
  buildLaunch,
  collectRepositorySkillPaths,
  validateProfile,
  mcpUrlVariable,
  sessionTokenVariable,
  type RunnerProfile,
  type LaunchRequest,
} from '../packages/runner/src/profiles.js';

const secret = `ms_${'s'.repeat(43)}`;
const codex: RunnerProfile = {
  name: 'local-codex',
  harness: 'codex',
  executable: '/opt/bin/codex',
  enabled: true,
  parallelism: 2,
};
const claude: RunnerProfile = {
  name: 'local-claude',
  harness: 'claude',
  executable: '/opt/bin/claude',
  enabled: true,
  parallelism: 2,
};
const command: RunnerProfile = {
  name: 'worker',
  harness: 'command',
  executable: '/opt/bin/worker',
  args: ['run'],
  enabled: true,
  parallelism: 1,
};
function request(readOnly = false): LaunchRequest {
  const target = {
    instanceId: 'instance_fixture',
    projectId: 'project_fixture',
    actorId: 'worker_fixture',
    workflow: 'task',
    version: 1,
    state: 'working',
  };
  const session: Session = {
    id: 'session_fixture',
    projectId: target.projectId,
    actorId: target.actorId,
    source: {
      kind: 'key',
      actorId: 'source-member-not-for-child',
      projectId: target.projectId,
      keyId: 'source-key-not-for-child',
      membershipId: 'membership_fixture',
      expiresAt: null,
    },
    instanceId: target.instanceId,
    expectedRevision: 3,
    role: 'producer',
    status: 'offered',
    runnerId: 'runner_fixture',
    hostRef: null,
    createdAt: '2026-09-15T00:00:00Z',
    activatedAt: null,
    expiresAt: '2026-09-15T00:05:00Z',
    hardDeadline: '2026-09-15T04:00:00Z',
    closedAt: null,
    closeReason: null,
    assignment: {
      ...target,
      revision: 3,
      role: 'producer',
      label: 'Assigned work',
      brief: 'Use the frozen assignment.',
      references: [],
      handoff: { instruction: 'Submit the checkpoint and stop.', tools: ['task.checkpoint'] },
      execution: { readOnly, tools: [{ name: 'task.get', arguments: { taskId: 'task_fixture' } }] },
      context: null,
      workStart: null,
    },
    execution: {
      ...target,
      revision: 3,
      policyHash: 'policy_fixture',
      registrationId: 'registration_fixture',
      references: {},
      policy: {
        readOnly,
        tools: [
          { name: 'task.get', alternatives: [{}] },
          { name: 'task.checkpoint', alternatives: [{}] },
          { name: '_nisa.search', alternatives: [{}] },
        ],
      },
    },
    lease: {
      ...target,
      leaseId: 'session_fixture',
      expectedRevision: 3,
      policyHash: 'policy_fixture',
      registrationId: 'registration_fixture',
      receipt: {},
    },
  };
  return {
    session,
    secret,
    mcpUrl: 'http://127.0.0.1:8080/mcp',
    cwd: '/tmp/merv-profile-workspace',
  };
}
const safeEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/worker',
  USER: 'worker',
  TMPDIR: '/tmp',
  LANG: 'en_US.UTF-8',
  CODEX_HOME: '/home/worker/.codex',
};
function config(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++)
    if (args[i] === '-c') {
      const assignment = args[++i],
        at = assignment.indexOf('=');
      result[assignment.slice(0, at)] = assignment.slice(at + 1);
    }
  return result;
}

test('profiles admit supported local launch shapes and reject unsupported or executable-changing extras', () => {
  assert.deepEqual(validateProfile(codex), codex);
  assert.deepEqual(validateProfile(claude), claude);
  assert.deepEqual(validateProfile(command), command);
  for (const bad of [
    { ...codex, harness: 'gemini' },
    { ...claude, args: ['--resume'] },
    { ...codex, args: ['--dangerously-bypass-approvals-and-sandbox'] },
    { ...codex, env: { OPENAI_API_KEY: 'must-not-print' } },
    { ...command, model: 'ignored-model' },
    { ...command, effort: 'ignored-effort' },
    { ...codex, parallelism: 0 },
    { ...codex, parallelism: 33 },
    { ...codex, name: '../escape' },
    { ...command, args: ['nul\0arg'] },
    { ...codex, executable: '/bin/codex\nextra' },
  ])
    assert.throws(() => validateProfile(bad), { code: 'invalid_runner_profile' });
  assert.throws(() => buildLaunch({ ...codex, enabled: false }, request(), safeEnv), {
    code: 'runner_profile_disabled',
  });
});

test('Codex uses the fixed MCP allowlist, retains sandboxed shell, and has no implicit model override', () => {
  const spec = buildLaunch(codex, request(), safeEnv),
    settings = config(spec.args);
  assert.equal(spec.executable, codex.executable);
  assert.equal(spec.args[0], 'exec');
  assert.equal(spec.args.at(-1), '-');
  assert.equal(spec.args[spec.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(spec.args[spec.args.indexOf('-C') + 1], spec.cwd);
  for (const flag of [
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--json',
  ])
    assert(spec.args.includes(flag));
  assert.equal(settings['approval_policy'], '"never"');
  assert.equal(settings['features.shell_tool'], 'true');
  assert.equal(settings['sandbox_workspace_write.network_access'], 'false');
  assert.equal(settings['sandbox_workspace_write.writable_roots'], '[]');
  assert.equal(settings['sandbox_workspace_write.exclude_tmpdir_env_var'], 'true');
  assert.equal(settings['sandbox_workspace_write.exclude_slash_tmp'], 'true');
  for (const feature of [
    'apps',
    'plugins',
    'hooks',
    'remote_plugin',
    'multi_agent',
    'shell_snapshot',
    'tool_suggest',
    'browser_use',
    'computer_use',
  ])
    assert.equal(settings[`features.${feature}`], 'false');
  assert.equal(settings.web_search, '"disabled"');
  assert.equal(settings['skills.config'], '[]');
  assert.match(
    settings.mcp_servers,
    /enabled_tools=\["task.get","task.checkpoint","_nisa.search"\]/,
  );
  assert.match(settings.mcp_servers, /"task.checkpoint"=\{approval_mode="approve"\}/);
  assert.match(settings.mcp_servers, /url="http:\/\/127.0.0.1:8080\/mcp"/);
  assert.match(settings.mcp_servers, /bearer_token_env_var="MERV_AGENT_SESSION_TOKEN"/);
  assert.match(settings.mcp_servers, /required=true/);
  assert.equal(spec.args.includes('--model'), false);
  assert.equal(settings.model_reasoning_effort, undefined);
  assert.equal(
    spec.args.some((arg) => arg.includes('danger-full-access') || arg.includes('bypass')),
    false,
  );
});

test('repository skill discovery covers the working directory through the Git root, without siblings or outer repositories', (t) => {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'merv-profile-skills-')));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const root = join(outer, 'checkout');
  const cwd = join(root, 'packages', 'service');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(outer, '.git'));
  // A worktree .git pointer is a root boundary even though its common dir is elsewhere.
  writeFileSync(join(root, '.git'), 'gitdir: /private/owned-common/worktrees/checkout\n');
  const skill = (directory: string, name: string) => {
    const path = join(directory, '.agents', 'skills', name, 'SKILL.md');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '---\nname: fixture\ndescription: fixture\n---\n');
    return path;
  };
  const expected = [
    skill(root, 'root'),
    skill(join(root, 'packages'), 'shared/nested'),
    skill(cwd, 'service'),
  ].sort();
  skill(outer, 'outside-worktree');
  skill(join(root, 'packages', 'sibling'), 'not-an-ancestor');
  skill(join(cwd, 'child'), 'not-an-ancestor');
  assert.deepEqual(collectRepositorySkillPaths(cwd), expected);
  // Discovery never reads, rewrites or removes repository instruction contents.
  assert.deepEqual(collectRepositorySkillPaths(cwd), expected);
});

test('nonrepository discovery visits cwd only and canonicalizes its launch path', (t) => {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'merv-profile-no-repository-')));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const cwd = join(outer, 'scratch');
  const skill = join(cwd, '.agents', 'skills', 'local', 'SKILL.md');
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, 'fixture');
  mkdirSync(join(outer, '.agents', 'skills', 'outer'), { recursive: true });
  writeFileSync(join(outer, '.agents', 'skills', 'outer', 'SKILL.md'), 'outside');
  symlinkSync(cwd, join(outer, 'launch-link'));
  assert.deepEqual(collectRepositorySkillPaths(join(outer, 'launch-link')), [skill]);
});

test('repository skill discovery rejects symlinked roots, directories and files instead of missing followed instructions', (t) => {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'merv-profile-skill-links-')));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const target = join(outer, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'SKILL.md'), 'fixture');
  for (const name of [
    '.agents',
    '.agents/skills',
    '.agents/skills/linked',
    '.agents/skills/local/SKILL.md',
  ]) {
    const root = join(outer, `case-${name.replaceAll('/', '-')}`);
    mkdirSync(join(root, '.git'), { recursive: true });
    const link = join(root, name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(name.endsWith('SKILL.md') ? join(target, 'SKILL.md') : target, link);
    assert.throws(() => collectRepositorySkillPaths(root), { code: 'unsafe_repository_skills' });
  }
});

test('repository skill discovery fails closed beyond its entry bound', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'merv-profile-skill-bound-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.git'));
  const skills = join(root, '.agents', 'skills');
  mkdirSync(skills, { recursive: true });
  for (let i = 0; i < 4097; i++) writeFileSync(join(skills, `asset-${i}`), '');
  assert.throws(() => collectRepositorySkillPaths(root), { code: 'unsafe_repository_skills' });
});

test('Codex disables exact repository SKILL.md paths using literal config without filesystem reads or tracked edits', () => {
  const paths = ['/not-on-disk/quoted"skill/SKILL.md', '/not-on-disk/plain/SKILL.md'];
  const spec = buildLaunch(
    codex,
    { ...request(), disabledSkillPaths: [...paths, paths[0]] },
    safeEnv,
  );
  assert.equal(
    config(spec.args)['skills.config'],
    `[${[...paths]
      .sort()
      .map((path) => `{path=${JSON.stringify(path)},enabled=false}`)
      .join(',')}]`,
  );
  for (const path of [
    'relative/SKILL.md',
    '/absolute/skill-folder',
    '/absolute/../SKILL.md',
    '/bad\n/SKILL.md',
  ])
    assert.throws(() => buildLaunch(codex, { ...request(), disabledSkillPaths: [path] }, safeEnv), {
      code: 'invalid_runner_launch',
    });
});

test('read-only Codex still receives explicitly authorized protocol writes, while command refuses the lease', () => {
  const spec = buildLaunch(codex, request(true), safeEnv);
  assert.equal(spec.args[spec.args.indexOf('--sandbox') + 1], 'read-only');
  assert.match(config(spec.args).mcp_servers, /task.checkpoint/);
  assert.match(spec.stdin, /filesystem is read-only/);
  assert.throws(() => buildLaunch(command, request(true), safeEnv), {
    code: 'unsupported_read_only',
  });
});

test('Claude Code runs headless on the Merv server alone, reads its bearer from the environment, and keeps only read tools on a read-only lease', () => {
  const spec = buildLaunch(claude, request(), safeEnv);
  assert.equal(spec.executable, '/opt/bin/claude');
  assert.ok(spec.args.includes('--print') && spec.args.includes('--strict-mcp-config'));
  const config = JSON.parse(spec.args[spec.args.indexOf('--mcp-config') + 1]!);
  assert.deepEqual(Object.keys(config.mcpServers), ['merv']);
  assert.equal(config.mcpServers.merv.headers.Authorization, 'Bearer ${MERV_AGENT_SESSION_TOKEN}');
  assert.ok(!JSON.stringify(spec.args).includes(secret));
  assert.equal(spec.env.MERV_AGENT_SESSION_TOKEN, secret);
  assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'opus');
  assert.equal(spec.args[spec.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash,Write,Edit');
  assert.match(spec.stdin, /Frozen assignment/);
  const reviewer = buildLaunch(
    { ...claude, model: 'claude-opus-5', effort: 'high' },
    request(true),
    safeEnv,
  );
  assert.equal(reviewer.args[reviewer.args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(
    reviewer.args[reviewer.args.indexOf('--allowedTools') + 1],
    'Read,Glob,Grep,mcp__merv',
  );
  assert.equal(reviewer.args[reviewer.args.indexOf('--model') + 1], 'claude-opus-5');
  assert.equal(reviewer.args[reviewer.args.indexOf('--effort') + 1], 'high');
});

test('the child receives its session bearer but no inherited machine key, provider key or executable preload', () => {
  const dirty = {
    ...safeEnv,
    MERV_MACHINE_KEY: 'mk_parent-secret',
    OPENAI_API_KEY: 'provider-secret',
    MERV_AGENT_SESSION_TOKEN: 'wrong-parent-session',
    NODE_OPTIONS: '--require /tmp/injected.js',
    DYLD_INSERT_LIBRARIES: '/tmp/injected.dylib',
    LD_PRELOAD: '/tmp/injected.so',
    HTTPS_PROXY: 'https://proxy-with-secret',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    SHELL: '/tmp/arbitrary-shell',
  };
  const spec = buildLaunch(codex, request(), dirty),
    settings = config(spec.args);
  assert.deepEqual(
    Object.keys(spec.env).sort(),
    [...Object.keys(safeEnv), mcpUrlVariable, sessionTokenVariable].sort(),
  );
  assert.equal(spec.env[sessionTokenVariable], secret);
  assert.equal(spec.env[mcpUrlVariable], 'http://127.0.0.1:8080/mcp');
  assert.equal(spec.env.CODEX_HOME, safeEnv.CODEX_HOME);
  assert.equal(settings['allow_login_shell'], 'false');
  assert.equal(settings['shell_environment_policy.inherit'], '"none"');
  assert.equal(settings['shell_environment_policy.experimental_use_profile'], 'false');
  assert.equal(settings['shell_environment_policy.ignore_default_excludes'], 'false');
  assert.equal(settings['shell_environment_policy.set'].includes(sessionTokenVariable), false);
  assert.equal(settings['shell_environment_policy.set'].includes('CODEX_HOME'), false);
  assert.equal(JSON.stringify(spec.args).includes(secret), false);
  assert.equal(spec.stdin.includes(secret), false);
  for (const value of [
    'mk_parent-secret',
    'provider-secret',
    'wrong-parent-session',
    'injected.js',
  ]) {
    assert.equal(Object.values(spec.env).includes(value), false);
    assert.equal(JSON.stringify(spec).includes(value), false);
  }
});

test('only explicit Codex model and effort settings produce overrides, with literal TOML quoting', () => {
  const spec = buildLaunch(
    { ...codex, model: 'configured-model', effort: 'high' },
    request(),
    safeEnv,
  );
  assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'configured-model');
  assert.equal(config(spec.args).model_reasoning_effort, '"high"');
  const quoted = buildLaunch(
    { ...codex, model: 'literal"model', effort: 'literal"effort' },
    request(),
    safeEnv,
  );
  assert.equal(quoted.args[quoted.args.indexOf('--model') + 1], 'literal"model');
  assert.equal(config(quoted.args).model_reasoning_effort, '"literal\\"effort"');
});

test('custom command preserves literal argv, endpoint and frozen assignment without source identity', () => {
  const args = ['$(touch /tmp/never)', '`echo never`', '$MERV_MACHINE_KEY', 'two words', ''];
  const input = request(),
    snapshot = JSON.stringify(input.session.assignment);
  const spec = buildLaunch({ ...command, args }, input, safeEnv);
  assert.deepEqual(spec.args, args);
  assert.notEqual(spec.args, args);
  assert.equal(spec.env[mcpUrlVariable], input.mcpUrl);
  assert.equal(spec.env[sessionTokenVariable], input.secret);
  assert.equal(spec.cwd, input.cwd);
  assert(spec.stdin.includes(snapshot));
  assert.equal(spec.stdin.includes('source-key-not-for-child'), false);
  assert.equal(spec.stdin.includes('source-member-not-for-child'), false);
  input.session.assignment.brief = 'changed after launch preparation';
  assert(spec.stdin.includes(snapshot));
  assert.equal(spec.stdin.includes('changed after launch preparation'), false);
});

test('launch diagnostics redact the bearer and frozen context without altering spawn environment', () => {
  const spec = buildLaunch(command, request(), safeEnv);
  for (const serialized of [
    JSON.stringify(spec),
    inspect(spec),
    JSON.stringify(spec.env),
    inspect(spec.env),
  ]) {
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('Use the frozen assignment.'), false);
    assert(serialized.includes('[redacted]'));
  }
  assert.equal(spec.env[sessionTokenVariable], secret);
  assert(Object.entries(spec.env).every(([, value]) => typeof value === 'string'));
});

test('launch rejects closed or inconsistent lease metadata, source credentials and unsafe endpoints', () => {
  for (const mutate of [
    (r: LaunchRequest) => {
      r.session.status = 'released';
    },
    (r: LaunchRequest) => {
      r.session.status = 'expired';
    },
    (r: LaunchRequest) => {
      r.session.assignment.revision++;
    },
    (r: LaunchRequest) => {
      r.session.execution.actorId = 'different';
    },
    (r: LaunchRequest) => {
      r.session.assignment.projectId = 'different';
    },
    (r: LaunchRequest) => {
      r.session.assignment.execution.readOnly = true;
    },
    (r: LaunchRequest) => {
      r.secret = `mk_${'k'.repeat(43)}`;
    },
    (r: LaunchRequest) => {
      r.cwd = 'relative/workspace';
    },
    (r: LaunchRequest) => {
      r.session.execution.policy.tools[0].name = 'bad"tool';
    },
  ]) {
    const input = request();
    mutate(input);
    assert.throws(() => buildLaunch(codex, input, safeEnv));
  }
  for (const mcpUrl of [
    'relative',
    'http://remote.example/mcp',
    'https://user:secret@example.com/mcp',
    'https://example.com/mcp?token=secret',
    'https://example.com/mcp#fragment',
    'file:///tmp/mcp',
  ])
    assert.throws(() => buildLaunch(codex, { ...request(), mcpUrl }, safeEnv), {
      code: 'invalid_runner_launch',
    });
  for (const mcpUrl of ['https://merv.example/mcp', 'http://[::1]:8080/mcp'])
    assert.equal(buildLaunch(codex, { ...request(), mcpUrl }, safeEnv).env[mcpUrlVariable], mcpUrl);
});
