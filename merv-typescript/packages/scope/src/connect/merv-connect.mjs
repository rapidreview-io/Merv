#!/usr/bin/env node
// Merv's agent connector, stamped by one Merv server at /connect: a dependency-free stdio MCP
// server forwarding to it, and the command line that signs in, out and registers with clients.
//
// The key lives in ~/.merv/connect/<host>/credentials.json (0600). It is never printed, never in a
// tool result, and never in this program's output: every line it prints, on either stream, passes
// through say(), which redacts it as a backstop. Any process running as this person can still read
// that file.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir, hostname } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = '__MERV_ORIGIN__';
const SERVER_NAME = '__MERV_SERVER_NAME__';
const VERSION = '__MERV_VERSION__';

let token; // the key in use, for redaction
let verifier; // a pending sign-in's verifier, for redaction

function redact(value) {
  if (typeof value === 'string') {
    let text = value.replace(/mk_[A-Za-z0-9_-]{43}/g, '[redacted]');
    for (const secret of [token, verifier])
      if (secret) text = text.split(secret).join('[redacted]');
    return text;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key), redact(item)]),
    );
  return value;
}
/** The one way out: every line on stdout or stderr, text or a JSON-RPC message, is redacted. */
function say(value, stream = process.stdout) {
  const clean = redact(value);
  stream.write(`${typeof clean === 'string' ? clean : JSON.stringify(clean)}\n`);
}
const fail = (message) => {
  say(message, process.stderr);
  process.exit(1);
};
if (Number(process.versions.node.split('.')[0]) < 18)
  fail(`Merv's connector needs Node.js 18 or later; this is ${process.version}.`);
const origin = new URL(ORIGIN);
const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname);
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback))
  fail('This connector was stamped with an origin it refuses (https only).');
// The host, `_` and the port: an IPv6 literal without brackets, a `_` for each colon.
const HOSTDIR = origin.host.replace(/[[\]]/g, '').replaceAll(':', '_');
if (!/^[a-z0-9._-]+$/.test(HOSTDIR)) fail('This connector was stamped with an invalid origin.');

const HOME = homedir();
const MERV = join(HOME, '.merv');
const CONNECT = join(MERV, 'connect');
const DIR = join(CONNECT, HOSTDIR);
const BIN = join(DIR, 'bin');
const SHIM = join(BIN, 'merv-connect');
const KEYS_PAGE = `${ORIGIN}/ui/settings/keys`;
const TIMEOUT = Math.min(
  50_000,
  Math.max(1, Number(process.env.MERV_CONNECT_TIMEOUT_MS) || 50_000),
);
const uid = process.getuid?.();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Refusal extends Error {}

/** Refuses what another user placed or can change: a link, the wrong kind, not this person's (HOME
 *  may be root's), or open to others beyond `mask`. */
function check(path, stat, kind, mask, owners = [uid]) {
  if (stat.isSymbolicLink()) throw new Refusal(`Refusing ${path}: it is a symlink.`);
  if (kind === 'dir' ? !stat.isDirectory() : !stat.isFile())
    throw new Refusal(`Refusing ${path}: unexpected file type.`);
  if (uid !== undefined && !owners.includes(stat.uid))
    throw new Refusal(`Refusing ${path}: it is not owned by you.`);
  if (stat.mode & mask)
    throw new Refusal(`Refusing ${path}: it is open to other users (chmod go-w,go-r).`);
}
/** HOME and each directory below it to `dirs`' last: missing ones made 0700; none writable by
 *  anyone else, so no one else can swap a name inside. Ours are kept 0700. */
function ensureDir(dirs = [MERV, CONNECT, DIR]) {
  check(HOME, fs.statSync(HOME), 'dir', 0o022, [uid, 0]);
  for (const dir of dirs) {
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    const stat = fs.lstatSync(dir);
    check(dir, stat, 'dir', 0o022);
    if (dir !== MERV && stat.mode & 0o077) fs.chmodSync(dir, 0o700);
  }
}
/** A file's text through one descriptor, opened without following a link and checked there as
 *  this person's own regular file closed to others; undefined when absent. */
function readPrivate(path, mask = 0o077, snapshot = false) {
  let fd;
  try {
    fd = fs.openSync(
      path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error.code === 'ELOOP' || error.code === 'EMLINK')
      throw new Refusal(`Refusing ${path}: it is a symlink.`);
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    check(path, stat, 'file', mask);
    const text = fs.readFileSync(fd, 'utf8');
    return snapshot ? { text, stat } : text;
  } finally {
    fs.closeSync(fd);
  }
}
function readFile(name) {
  ensureDir();
  return readPrivate(join(DIR, name));
}
function readJson(name) {
  const text = readFile(name);
  return text === undefined ? undefined : parse(text);
}
/** A temp file created exclusively beside the target, then renamed over it. */
function writeAtomic(dir, name, text, mode = 0o600) {
  const temp = join(dir, `.${name}.${randomBytes(6).toString('hex')}`);
  fs.writeFileSync(temp, text, { flag: 'wx', mode });
  fs.chmodSync(temp, mode); // Preserve the requested mode even under a restrictive umask.
  fs.renameSync(temp, join(dir, name));
}
const writeJson = (name, value) => {
  ensureDir();
  writeAtomic(DIR, name, `${JSON.stringify(value, null, 2)}\n`);
};
function remove(name) {
  ensureDir();
  fs.rmSync(join(DIR, name), { force: true });
}
function installId() {
  const existing = readFile('install-id')?.trim();
  if (existing && /^[0-9a-f-]{36}$/.test(existing)) return existing;
  const id = randomUUID();
  writeAtomic(DIR, 'install-id', `${id}\n`);
  return id;
}

/** Creates `path` holding `text` in one step, or fails with EEXIST: no reader sees it empty. */
function createWhole(path, text) {
  const temp = `${path}.${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
  try {
    fs.linkSync(temp, path);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
/** A lock's holder, or `{ stale: true }` once it is dead, older than 120 s, or unreadable and old. */
function lockState(path) {
  let text;
  let stat;
  try {
    stat = fs.lstatSync(path);
    text = fs.readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  const held = parse(text);
  let alive = true;
  try {
    if (held?.pid) process.kill(held.pid, 0);
  } catch (probe) {
    alive = probe.code !== 'ESRCH';
  }
  const at = typeof held?.at === 'number' ? held.at : stat.mtimeMs;
  return { text, stale: !alive || Date.now() - at > 120_000 };
}

/** One holder at a time per origin. A stale lock is removed only under a second, short-lived lock,
 *  and only if it is still the very lock judged stale, so two waiters never both take over. */
async function withLock(fn, path = join(DIR, 'lock')) {
  ensureDir();
  const token = randomUUID();
  const breaker = `${path}.break`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      createWhole(path, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const held = lockState(path);
    if (held?.stale) {
      try {
        createWhole(breaker, JSON.stringify({ pid: process.pid, at: Date.now() }));
        try {
          if (lockState(path)?.text === held.text) fs.rmSync(path, { force: true });
        } finally {
          fs.rmSync(breaker, { force: true });
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // A breaker that died mid-takeover: its few milliseconds are long past.
        if (lockState(breaker)?.stale) fs.rmSync(breaker, { force: true });
      }
      continue;
    }
    if (Date.now() > deadline) throw new Refusal('Another Merv sign-in is in progress; try again.');
    await sleep(held ? 100 : 0);
  }
  try {
    return await fn();
  } finally {
    try {
      if (JSON.parse(fs.readFileSync(path, 'utf8')).token === token) fs.unlinkSync(path);
    } catch {
      // Taken over, or already gone.
    }
  }
}

// ---- Merv's HTTP API: fixed paths on ORIGIN, no redirects. ----

async function api(path, { method = 'GET', body, key, timeout = 30_000 } = {}) {
  const response = await fetch(`${ORIGIN}${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, value: await response.json().catch(() => undefined) };
}
const refusalOf = ({ status, value }) => value?.error?.message ?? `Merv answered ${status}.`;

function credential() {
  const stored = readJson('credentials.json');
  if (!stored || typeof stored.token !== 'string' || stored.origin !== ORIGIN) return undefined;
  if (Date.parse(stored.expiresAt) <= Date.now()) return undefined;
  token = stored.token;
  return stored;
}

/** After a 401 for `keyId`, with the lock held: delete that exact key if it is still the stored
 *  one, and return whatever other credential another process stored meanwhile. */
function dropKey(keyId) {
  const stored = readJson('credentials.json');
  if (stored?.keyId === keyId) remove('credentials.json');
  return stored?.keyId !== keyId ? credential() : undefined;
}
const refused = (keyId) => withLock(() => dropKey(keyId));

/** With the lock held: the signed-in credential, unless Merv says it no longer holds. */
async function liveCredential() {
  const stored = credential();
  if (!stored) return undefined;
  const answer = await api('/account', { key: stored.token, timeout: 15_000 }).catch(() => ({
    status: 0,
  }));
  return answer.status === 401 ? dropKey(stored.keyId) : stored;
}

const clientNames = [
  [/claude/i, 'Claude Code'],
  [/codex/i, 'Codex'],
  [/cursor/i, 'Cursor'],
];
// Merv takes letters, digits, `_` and `-` in single-spaced words: nothing an email could link.
const clientLabel = (name) =>
  clientNames.find(([pattern]) => pattern.test(name ?? ''))?.[1] ??
  (String(name ?? '')
    .replace(/[^\p{L}\p{N} _-]/gu, ' ')
    .replace(/ +/g, ' ')
    .slice(0, 40)
    .trim() ||
    'Terminal');
const host = () =>
  hostname()
    .split('.')[0]
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .slice(0, 64) || 'this-machine';
const NOT_HERE = 'Not signed in to Merv on this machine.';
const statusLine = (value) =>
  value.signedIn
    ? `Signed in as ${value.email} (${value.label}). Projects: ${
        value.projects.map((project) => `${project.name} (${project.role})`).join(', ') || 'none'
      }. Key expires ${value.expiresAt.slice(0, 10)}.`
    : NOT_HERE;
const already = (stored) =>
  `Already signed in as ${stored.email} (${stored.label}). To switch accounts, the person runs \`merv-connect logout\` in a terminal first.`;

async function startLogin(email, client, next) {
  return await withLock(async () => {
    const stored = await liveCredential();
    if (stored) throw new Refusal(already(stored));
    const secret = randomBytes(32).toString('base64url');
    const answer = await api('/connect/login', {
      method: 'POST',
      body: {
        email,
        client: { name: clientLabel(client), host: host(), installId: installId() },
        verifierHash: createHash('sha256').update(secret).digest('base64url'),
      },
    });
    if (answer.status !== 202) {
      const wait = answer.status === 429 ? ' Try again later.' : '';
      throw new Refusal(`${refusalOf(answer)}${wait}`);
    }
    const { loginId, phrase, expiresAt } = answer.value;
    writeJson('pending.json', { generation: randomUUID(), loginId, verifier: secret, expiresAt });
    return `Code sent if ${email} is a Merv account in a project. Request: ${phrase}. Tell the person to check that the email shows the same words, then ${next}.`;
  });
}

async function finishLogin(code) {
  return await withLock(async () => {
    const pending = readJson('pending.json');
    if (!pending || Date.parse(pending.expiresAt) <= Date.now())
      throw new Refusal('No sign-in is waiting, or it expired. Start again with login <email>.');
    verifier = pending.verifier;
    const answer = await api(`/connect/login/${encodeURIComponent(pending.loginId)}/verify`, {
      method: 'POST',
      body: { code: String(code), verifier: pending.verifier },
    });
    if (answer.status !== 200) throw new Refusal(refusalOf(answer));
    const issued = answer.value;
    token = issued.token;
    // A completion is installed only for the request it belongs to: never an older login's key.
    if (readJson('pending.json')?.generation !== pending.generation) {
      await api('/account/key', { method: 'DELETE', key: issued.token }).catch(() => undefined);
      throw new Refusal('Another sign-in replaced this one.');
    }
    const { email, projects, key } = issued;
    writeJson('credentials.json', {
      origin: ORIGIN,
      email,
      keyId: key.id,
      token: issued.token,
      label: key.label,
      expiresAt: key.expiresAt,
    });
    remove('pending.json');
    verifier = undefined;
    return statusLine({ signedIn: true, email, projects, ...key });
  });
}

async function status() {
  const stored = credential();
  if (!stored) return { signedIn: false };
  const answer = await api('/account', { key: stored.token, timeout: 15_000 });
  if (answer.status === 401) {
    await refused(stored.keyId);
    return { signedIn: false };
  }
  if (answer.status !== 200) throw new Refusal(refusalOf(answer));
  const { key, projects } = answer.value;
  return {
    signedIn: true,
    email: stored.email,
    label: key?.label ?? stored.label,
    expiresAt: key?.expiresAt ?? stored.expiresAt,
    projects: (projects ?? []).map(({ id, name, role }) => ({ id, name, role })),
  };
}
/** Under the lock, so a sign-in started earlier can never complete after it: its verifier goes. */
async function logout() {
  return await withLock(async () => {
    remove('pending.json');
    remove('tools.json');
    const stored = readJson('credentials.json');
    if (!stored?.token) return NOT_HERE;
    const answer = await api('/account/key', { method: 'DELETE', key: stored.token }).catch(
      () => undefined,
    );
    remove('credentials.json');
    if (answer?.status === 200 || answer?.status === 401)
      return `Signed out of Merv; the key for ${stored.label} is revoked.`;
    return `Signed out here, but Merv could not be reached: the key stays live until you revoke it on the Keys page: ${KEYS_PAGE}`;
  });
}

const onPath = (name) =>
  (process.env.PATH ?? '').split(delimiter).some((dir) => {
    try {
      fs.accessSync(join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
const run = (command, args, env = clientEnv) =>
  spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, stdio: 'pipe', env });
const entry = { type: 'stdio', command: SHIM, args: [] };
const registered = (client) => {
  const got = run(client, ['mcp', 'get', SERVER_NAME]);
  return got.status === 0 ? got.stdout : undefined;
};
const removeFromClaude = () => {
  for (const scope of ['local', 'user']) {
    validateClients();
    run('claude', ['mcp', 'remove', SERVER_NAME, '-s', scope]);
  }
};
const connectorOf = (settings) =>
  /\.merv\/connect\/([^/\s"']+)\/bin\/merv-connect/.exec(settings ?? '')?.[1];
/** Another Merv server's connector under this name is that server's: left alone. */
function foreign(client, settings) {
  const other = connectorOf(settings);
  if (other === undefined || other === HOSTDIR) return false;
  say(
    `${client}: "${SERVER_NAME}" runs the connector for another Merv server (${other}), so it was left alone. To switch, run that connector's uninstall first.`,
  );
  return true;
}
const replacing = (client, settings, copy) =>
  settings !== undefined &&
  connectorOf(settings) === undefined &&
  say(
    `${client}: replacing an earlier "${SERVER_NAME}"${copy ? ` (previous config saved as ${copy})` : ''}. Its settings are not shown, since they may hold a key. If it used a Merv key, revoke that key on the Keys page once nothing needs it: ${KEYS_PAGE}`,
  );
function backup(file) {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;
  const copy = `${file}.bak-${Date.now()}`;
  fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(copy, 0o600);
  return copy;
}

const codexDir = resolve(process.env.CODEX_HOME || join(HOME, '.codex'));
const claudeDir = resolve(process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude'));
const clientEnv = { ...process.env };
if (clientEnv.CODEX_HOME) clientEnv.CODEX_HOME = codexDir;
if (clientEnv.CLAUDE_CONFIG_DIR) clientEnv.CLAUDE_CONFIG_DIR = claudeDir;

/** Check every directory down from HOME (or the filesystem root for a custom location), before
 *  creating anything. Client files may be readable, but never writable by another user. */
function clientPath(dir, name, create = false) {
  const parents = [];
  for (let at = dir; ; at = dirname(at)) {
    parents.unshift(at);
    if (at === HOME || dirname(at) === at) break;
  }
  for (const path of parents) {
    const stat = fs.lstatSync(path, { throwIfNoEntry: false });
    if (stat)
      check(
        path,
        stat,
        'dir',
        0o022,
        path === dir || path === HOME || path.startsWith(`${HOME}/`) ? [uid] : [uid, 0],
      );
    else if (create) fs.mkdirSync(path, { mode: 0o700 });
  }
  return readPrivate(join(dir, name), 0o022, true);
}
const sameConfig = (a, b) =>
  a?.text === b?.text &&
  ['dev', 'ino', 'uid', 'mode', 'mtimeMs', 'ctimeMs'].every((key) => a?.stat[key] === b?.stat[key]);
const lineEnding = (text) => (text?.includes('\r\n') ? '\r\n' : '\n');

/** Keep our lock as well as checking for outside writers immediately before the rename. */
async function editClientConfig(client, dir, name, change, save = false) {
  return await withLock(
    () => {
      const file = join(dir, name);
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = clientPath(dir, name);
        const after = change(before?.text);
        if (after === undefined || after === before?.text) return;
        clientPath(dir, name, true);
        const temp = join(dir, `.${name}.${randomBytes(6).toString('hex')}`);
        let copy;
        try {
          const mode = before ? before.stat.mode & 0o777 : 0o600;
          fs.writeFileSync(temp, after, { flag: 'wx', mode });
          fs.chmodSync(temp, mode);
          if (save && before) {
            copy = `${file}.bak-${Date.now()}`;
            fs.writeFileSync(copy, before.text, { flag: 'wx', mode: 0o600 });
          }
          if (!sameConfig(before, clientPath(dir, name))) {
            if (copy) fs.unlinkSync(copy);
            continue;
          }
          fs.renameSync(temp, file);
          return { copy };
        } finally {
          fs.rmSync(temp, { force: true });
        }
      }
      throw new Refusal(`${client}: ${file} kept changing; no edit committed. Try again.`);
    },
    join(CONNECT, `${client}.lock`),
  );
}

/** Let Codex remove its table in a private copy, append a complete replacement, and have Codex
 *  parse and verify it before committing. Never search TOML text for a header. */
async function codexApproval(installing, had) {
  const committed = await editClientConfig(
    'codex',
    codexDir,
    'config.toml',
    (before = '') => {
      const stage = fs.mkdtempSync(join(CONNECT, 'codex-config-'));
      try {
        const file = join(stage, 'config.toml');
        // Codex serializes LF; normalize first so restoring CRLF cannot double a string's CR.
        fs.writeFileSync(file, before.replace(/\r\n/g, '\n'), { mode: 0o600 });
        const env = { ...process.env, CODEX_HOME: stage };
        if (run('codex', ['mcp', 'remove', SERVER_NAME], env).status !== 0)
          throw new Refusal('Codex: could not remove the old registration; config left untouched.');
        const eol = lineEnding(before);
        let after = readPrivate(file).replace(/\r?\n/g, eol);
        if (installing) {
          after =
            after.trimEnd() +
            eol +
            eol +
            `[mcp_servers.${JSON.stringify(SERVER_NAME)}]${eol}` +
            `command = ${JSON.stringify(SHIM)}${eol}args = []${eol}` +
            `default_tools_approval_mode = "approve"${eol}`;
          fs.writeFileSync(file, after, { mode: 0o600 });
          const got = run('codex', ['mcp', 'get', SERVER_NAME, '--json'], env);
          const transport = parse(got.stdout)?.transport;
          if (
            got.status !== 0 ||
            transport?.type !== 'stdio' ||
            transport.command !== SHIM ||
            !Array.isArray(transport.args) ||
            transport.args.length !== 0
          )
            throw new Refusal('Codex: could not verify Merv’s command; config left untouched.');
        }
        return after;
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
      }
    },
    installing,
  );
  if (installing) replacing('Codex', had, committed?.copy);
}

/** Claude Code asks before each MCP tool it has not been told to allow. Only an entry this
 *  installer added is removed again; one the person had stays theirs. */
async function claudeApproval(installing) {
  const dir = claudeDir;
  const path = join(dir, 'settings.json');
  const owned = 'claude-approval.json';
  const permission = `mcp__${SERVER_NAME}`;
  const committed = await editClientConfig(
    'claude',
    dir,
    'settings.json',
    (before) => {
      if (!installing && readJson(owned)?.path !== path) return;
      const config = before === undefined ? {} : parse(before);
      if (!config || typeof config !== 'object' || Array.isArray(config))
        throw new Refusal(`Claude Code: invalid JSON settings in ${path}; left alone.`);
      const allow = config.permissions?.allow ?? [];
      if (!Array.isArray(allow))
        throw new Refusal(
          `Claude Code: permissions.allow in ${join(dir, 'settings.json')} is not a list; left alone.`,
        );
      if (installing === allow.includes(permission)) return;
      config.permissions = {
        ...config.permissions,
        allow: installing ? [...allow, permission] : allow.filter((item) => item !== permission),
      };
      return `${JSON.stringify(config, null, 2)}\n`.replace(/\n/g, lineEnding(before));
    },
    true,
  );
  if (installing && committed) writeJson(owned, { path });
  if (!installing) remove(owned);
}

async function cursor(change) {
  const dir = join(HOME, '.cursor');
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
  const file = join(dir, 'mcp.json');
  await withLock(
    () => {
      if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
        say(
          `Cursor: ${file} is a symlink, so it was left alone. Add this under "mcpServers": "${SERVER_NAME}": ${JSON.stringify(entry)}`,
        );
        return;
      }
      const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      config.mcpServers = config.mcpServers ?? {};
      const said = change(config.mcpServers, () => backup(file));
      if (!said) return;
      say(said);
      writeAtomic(dir, 'mcp.json', `${JSON.stringify(config, null, 2)}\n`);
    },
    join(CONNECT, 'cursor.lock'),
  );
}

/** Places this file, as read and checked through one descriptor (and, from the installer, whose
 *  digest matches again), and a shim that runs it with `node`; then registers it with each client. */
async function install(sha, node = process.execPath) {
  validateClients();
  ensureDir([MERV, CONNECT, DIR, BIN]);
  const self = readPrivate(fileURLToPath(import.meta.url));
  if (sha && createHash('sha256').update(self).digest('hex') !== sha)
    throw new Refusal('Download check failed. Nothing was installed.');
  if (node.includes("'")) throw new Refusal(`Unsupported node path: ${node}`);
  writeAtomic(DIR, 'merv-connect.mjs', self);
  const shim = `#!/bin/sh\nN='${node}'\n[ -x "$N" ] || N="$(command -v node)"\nexec "$N" "$HOME/.merv/connect/${HOSTDIR}/merv-connect.mjs" "$@"\n`;
  writeAtomic(BIN, 'merv-connect', shim, 0o700);
  let found = false;
  if (onPath('claude')) {
    found = true;
    const had = registered('claude');
    if (!foreign('Claude Code', had)) {
      replacing('Claude Code', had);
      removeFromClaude();
      validateClients();
      const added = run('claude', [
        'mcp',
        'add-json',
        SERVER_NAME,
        JSON.stringify(entry),
        '-s',
        'user',
      ]);
      if (added.status === 0) await claudeApproval(true);
      say(
        added.status === 0
          ? `Claude Code: Merv's tools are allowed without asking (permissions.allow mcp__${SERVER_NAME}).`
          : `Claude Code: could not add "${SERVER_NAME}": ${(added.stderr || added.stdout).trim()}`,
      );
      if (/merv@/.test(run('claude', ['plugin', 'list']).stdout ?? ''))
        say(
          "Note: the Merv plugin is installed in Claude Code. If it registers a Merv server of its own, Merv's tools appear twice: disable that one in /mcp.",
        );
    }
  }
  if (onPath('codex')) {
    found = true;
    const had = registered('codex');
    if (!foreign('Codex', had)) {
      await codexApproval(true, had);
      say(`Codex: Merv's tools run without asking (default_tools_approval_mode = "approve").`);
    }
  }
  await cursor((servers, save) => {
    found = true;
    const had = servers[SERVER_NAME] && JSON.stringify(servers[SERVER_NAME]);
    if (foreign('Cursor', had)) return undefined;
    replacing('Cursor', had, had && !connectorOf(had) ? save() : undefined);
    servers[SERVER_NAME] = entry;
    return `Cursor: added "${SERVER_NAME}" (~/.cursor/mcp.json).`;
  });
  if (!found)
    say(
      `No Claude Code, Codex or Cursor found. Register this MCP server by hand: ${SERVER_NAME} -> ${SHIM}`,
    );
  say('Restart the client to load Merv.');
}

function validateClients() {
  if (onPath('codex')) clientPath(codexDir, 'config.toml');
  if (onPath('claude')) {
    clientPath(claudeDir, 'settings.json');
    // Claude's user MCP registration is separate from its permissions settings.
    clientPath(claudeDir, '.claude.json');
    clientPath(HOME, '.claude.json');
  }
}

async function uninstall() {
  validateClients();
  // Only this origin's registration: never another server's, nor one a person made by hand.
  const ours = (client) => onPath(client) && connectorOf(registered(client)) === HOSTDIR;
  if (ours('claude')) {
    await claudeApproval(false);
    removeFromClaude();
  }
  if (ours('codex')) await codexApproval(false);
  await cursor((servers) => {
    if (servers[SERVER_NAME]?.command !== SHIM) return undefined;
    delete servers[SERVER_NAME];
    return `Cursor: removed "${SERVER_NAME}".`;
  });
  say(`Removed "${SERVER_NAME}" from the installed clients.`);
  say(await logout());
}

const INSTRUCTIONS = `Merv is this person's research record: projects, papers, tasks, experiments, reviews and machines. When they say "check with Merv", "ask Merv" or ask how their research is going, use these tools. Call project.list, then pass projectId on every call; start with project.read brief and workflow.read status. Never ask for, print or read Merv keys or ~/.merv.
If a Merv tool says not signed in, ask the person for their Merv email and call connector.login with {email}; when they tell you the code, call connector.login with {code}.`;
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const NOT_SIGNED_IN =
  'Not signed in to Merv on this machine (the key was revoked or expired). Ask the person for the email they use for Merv and call connector.login.';
const UNDERSTOOD =
  'Merv answered in a form this connector does not understand (update it: rerun the install command).';
const TOOLS = [
  {
    name: 'connector.status',
    description:
      'Whether this machine is signed in to Merv: as whom, which agent key, until when, and the projects with your role in each.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'connector.login',
    description:
      'Sign this machine in to Merv by an emailed code. Call with {email} (ask the person for the email they use for Merv) and tell them the request words; when they give you the code from the email, call with {code}.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'The email the person uses for Merv.' },
        code: { type: 'string', description: 'The 8-digit code from the email.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
];

const text = (value, isError = false) => ({
  content: [{ type: 'text', text: value }],
  ...(isError && { isError: true }),
});
let client;
const listed = new Map();
let calls = 0;

class Unreadable extends Error {}
/** One JSON-RPC call to Merv's /mcp, which answers JSON (never SSE) for this connector. */
async function forward(method, params, key) {
  const id = `merv-connect-${++calls}`;
  const response = await fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      authorization: `Bearer ${key}`,
      'x-merv-client': `${clientLabel(client)}/${VERSION}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (response.status === 401) return { unauthorized: true };
  const body = (response.headers.get('content-type') ?? '').startsWith('application/json')
    ? await response.json().catch(() => undefined)
    : undefined;
  if (response.status !== 200) {
    if (body?.error?.message) return { refused: `${body.error.message} (${response.status})` };
    throw new Unreadable();
  }
  if (
    !body ||
    Array.isArray(body) ||
    body.jsonrpc !== '2.0' ||
    body.id !== id ||
    'result' in body === 'error' in body ||
    ('result' in body && (typeof body.result !== 'object' || body.result === null))
  )
    throw new Unreadable();
  return body;
}

/** Forwards with the stored key; after a 401, retries once only if another key is now stored. */
async function signedIn(method, params) {
  let stored = credential();
  for (let attempt = 0; stored && attempt < 2; attempt++) {
    const answer = await forward(method, params, stored.token);
    if (!answer.unauthorized) return answer;
    stored = await refused(stored.keyId);
  }
  return { unauthorized: true };
}

/** What to say about a failure; a forwarded call that got no answer may still have run. */
const failure = (error, forwarded = false) =>
  error instanceof Unreadable
    ? UNDERSTOOD
    : error instanceof Refusal
      ? error.message
      : error.syscall
        ? `Filesystem error (${error.code}) during ${error.syscall}${error.path ? ` at ${error.path}` : ''}.`
        : error instanceof SyntaxError
          ? 'Invalid JSON in local configuration.'
          : forwarded
            ? `Merv could not be reached or did not answer within ${Math.ceil(TIMEOUT / 1000)} s. The call may still have taken effect; check before repeating it.`
            : `Merv could not be reached at ${ORIGIN}. Check the network, then try again.`;

/** The client's own tools/list, forwarded as asked; each project selection is listed apart. */
async function listTools(params = {}) {
  const selection = String(params._meta?.['merv/projectId'] ?? '');
  let remote;
  try {
    const answer = await signedIn('tools/list', params);
    if (answer.result && Array.isArray(answer.result.tools)) {
      remote = answer.result.tools.filter((tool) => !tool.name?.startsWith('connector.'));
      writeJson('tools.json', { lists: { ...readJson('tools.json')?.lists, [selection]: remote } });
    }
  } catch {
    // Unreachable or unreadable: the last list stands.
  }
  const cached = readJson('tools.json')?.lists?.[selection];
  const tools = [...TOOLS, ...(remote ?? (Array.isArray(cached) ? cached : []))];
  const changed =
    listed.has(selection) && JSON.stringify(listed.get(selection)) !== JSON.stringify(tools);
  listed.set(selection, tools);
  if (changed) say({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  return { tools };
}

async function connectorTool(name, input) {
  if (name === 'connector.status') {
    const value = await status();
    return { ...text(statusLine(value)), structuredContent: value };
  }
  const { email, code, ...rest } = input ?? {};
  if (Object.keys(rest).length || (email === undefined) === (code === undefined))
    return text('Call connector.login with exactly one of {email} or {code}.', true);
  if (email !== undefined) {
    return text(
      await startLogin(String(email), client, 'call connector.login with {code} when they give it'),
    );
  }
  const done = await finishLogin(code);
  // Claude Code lists the tools again; Codex will not until it restarts.
  say({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  return text(done);
}

async function callTool(params) {
  const name = params?.name;
  if (typeof name === 'string' && name.startsWith('connector.')) {
    if (!TOOLS.some((tool) => tool.name === name))
      return text(`Unknown connector tool: ${name}`, true);
    return await connectorTool(name, params.arguments);
  }
  const answer = await signedIn('tools/call', params);
  if (answer.unauthorized) return text(NOT_SIGNED_IN, true);
  if (answer.refused) return text(`Merv refused the call: ${answer.refused}`, true);
  return answer;
}

async function handle(message) {
  const { id, method, params } = message;
  const reply = (result) => say({ jsonrpc: '2.0', id, result });
  try {
    if (method === 'initialize') {
      client = params?.clientInfo?.name;
      return reply({
        protocolVersion: PROTOCOLS.includes(params?.protocolVersion)
          ? params.protocolVersion
          : '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: SERVER_NAME, version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply(await listTools(params ?? {}));
    if (method === 'tools/call') {
      try {
        const answer = await callTool(params);
        if (answer.error) return say({ jsonrpc: '2.0', id, error: answer.error });
        return reply(answer.result ?? answer);
      } catch (error) {
        return reply(text(failure(error, !params?.name?.startsWith?.('connector.')), true));
      }
    }
    say({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (error) {
    say({ jsonrpc: '2.0', id, error: { code: -32603, message: failure(error) } });
  }
}

function serve() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        say({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      // Requests are answered concurrently; notifications and responses need nothing.
      if (message && typeof message.method === 'string' && message.id !== undefined)
        void handle(message);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
}

const USAGE = `Usage: merv-connect [login <email> [--client <name>] | login --code <code> | status | logout | install | uninstall]
With no arguments, merv-connect is the "${SERVER_NAME}" MCP server for ${ORIGIN}.
Install allows Merv's tools without asking in Codex and Claude Code; uninstall removes the registrations and permissions it added.`;

async function main(args) {
  const [command, ...rest] = args;
  if (command === undefined) return serve();
  const option = (name) => {
    const index = rest.indexOf(name);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  try {
    if (command === 'login' && rest[0] === '--code' && rest[1])
      say(await finishLogin(rest.slice(1).join(' ')));
    else if (command === 'login' && rest[0] && !rest[0].startsWith('--')) {
      const client =
        option('--client') ?? (process.env.CLAUDECODE === '1' ? 'Claude Code' : 'Terminal');
      say(await startLogin(rest[0], client, 'run: merv-connect login --code <code>'));
    } else if (command === 'status') say(statusLine(await status()));
    else if (command === 'logout') say(await logout());
    else if (command === 'install') await install(rest[0], rest[1]);
    else if (command === 'uninstall') await uninstall();
    else {
      say(USAGE);
      process.exitCode = command === 'help' || command === '--help' ? 0 : 1;
    }
  } catch (error) {
    say(failure(error), process.stderr);
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
