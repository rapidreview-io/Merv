/**
 * Public Git acceptance on an explicitly supplied disposable project. No project or key CRUD.
 * After the operator has prepared a project-scoped token in the named environment variable:
 *   node deploy/public-git-probe.mjs --base-url https://experiments.rapidreview.io \
 *     --project DISPOSABLE_ID --token-env MERV_GIT_PROBE_TOKEN --out PRIVATE_NEW_DIRECTORY
 * Add --wrong-project OTHER_ID to prove cross-project denial. Successful probe branches remain
 * under native-probe-<run-id>/; the reserved merv ref is also attempted and must be rejected.
 * Local fixture success does not establish acceptance through public TLS/Caddy/Cloudflare.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function runProbe({
  baseUrl,
  projectId,
  tokenEnv = 'MERV_GIT_PROBE_TOKEN',
  out,
  runId = new Date().toISOString().replace(/[^0-9]/g, ''),
  largeMiB = 16,
  wrongProjectId,
  allowLocal = false,
}) {
  const base = new URL(baseUrl);
  assert.ok(
    !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash,
  );
  assert.ok(
    base.protocol === 'https:' ||
      (allowLocal &&
        base.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)),
    'Use public HTTPS, or explicitly allow a local fixture',
  );
  assert.match(projectId, /^[A-Za-z0-9_-]{1,200}$/);
  assert.match(runId, /^[A-Za-z0-9_-]{1,64}$/);
  assert.match(tokenEnv, /^[A-Za-z_][A-Za-z0-9_]*$/);
  assert.ok(Number.isInteger(largeMiB) && largeMiB >= 1 && largeMiB <= 32);
  const token = process.env[tokenEnv];
  assert.ok(
    token,
    `Set ${tokenEnv}; credentials are never accepted as flags or written to Git config`,
  );
  const authorization = `Basic ${Buffer.from(`merv:${token}`).toString('base64')}`;
  const redact = (value) =>
    String(value)
      .split(token)
      .join('[redacted]')
      .split(authorization)
      .join('[redacted]')
      .replace(/Authorization:[^\r\n]*/gi, 'Authorization: [redacted]');
  out = resolve(out);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const remote = new URL(`/git/${projectId}.git`, base).href;
  const prefix = `native-probe-${runId}`;
  const local = join(out, 'checkout');
  const report = {
    startedAt: new Date().toISOString(),
    baseUrl: base.origin,
    projectId,
    namespace: `refs/heads/${prefix}/`,
    largeMiB,
    tests: [],
    requests: [],
    complete: false,
    limits: [
      'No deployment, project creation/deletion, credential creation/revocation or provider action.',
      'Successful probe refs/history remain in this disposable project; remote deletion is disabled.',
      'Large-body acceptance is measured at the configured size; the 2 GiB server ceiling is not saturated.',
      'Client cancellation verifies no published ref and subsequent health; edge buffering may prevent an incomplete body reaching Main.',
    ],
  };
  const trace = (stderr) => {
    for (const line of stderr.split('\n')) {
      const field = /=> Send header: (.*)$/i.exec(line)?.[1];
      if (
        field &&
        /^(?:POST |GET |content-encoding:|transfer-encoding:|content-length:|git-protocol:)/i.test(
          field,
        )
      )
        report.requests.push(field);
    }
  };
  async function git(cwd, args, { input, captureTrace = false } = {}) {
    return await new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          HOME: out,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '/bin/false',
          LC_ALL: 'C',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `http.${remote}.extraHeader`,
          GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
          GIT_AUTHOR_NAME: 'Native Git acceptance',
          GIT_AUTHOR_EMAIL: 'git-probe@example.invalid',
          GIT_COMMITTER_NAME: 'Native Git acceptance',
          GIT_COMMITTER_EMAIL: 'git-probe@example.invalid',
          ...(captureTrace
            ? { GIT_TRACE_CURL: '1', GIT_TRACE_CURL_NO_DATA: '1', GIT_TRACE_REDACT: '1' }
            : {}),
        },
      });
      const stdout = [],
        stderr = [];
      let size = 0;
      const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
      child.stdout.on('data', (data) => {
        size += data.length;
        if (size > 128 * 1024 ** 2) child.kill('SIGKILL');
        else stdout.push(data);
      });
      child.stderr.on('data', (data) => {
        if (stderr.reduce((n, c) => n + c.length, 0) < 2 * 1024 ** 2) stderr.push(data);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        const output = Buffer.concat(stdout),
          diagnostic = redact(Buffer.concat(stderr));
        if (captureTrace) trace(diagnostic);
        if (code === 0) resolve(output);
        else
          reject(
            Object.assign(
              new Error(`git ${args[0]} failed (${code ?? signal}): ${diagnostic.slice(-6000)}`),
              { stdout: output.toString(), stderr: diagnostic },
            ),
          );
      });
    });
  }
  const textGit = async (cwd, args, options) => (await git(cwd, args, options)).toString().trim();
  const refs = async () =>
    new Map(
      (await textGit(out, ['ls-remote', '--refs', remote]))
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [oid, name] = line.split('\t');
          return [name, oid];
        }),
    );
  const test = async (name, operation) => {
    const started = Date.now();
    try {
      const facts = await operation();
      report.tests.push({ name, passed: true, durationMs: Date.now() - started, facts });
    } catch (error) {
      report.tests.push({
        name,
        passed: false,
        durationMs: Date.now() - started,
        error: redact(error.message).slice(0, 7000),
      });
      throw error;
    }
  };
  async function request(
    path,
    { method = 'GET', auth = authorization, headers = {}, body, interruptMs } = {},
  ) {
    const target = new URL(path, base);
    return await new Promise((resolve, reject) => {
      let done = false;
      const finish = (value) => {
        if (!done) {
          done = true;
          clearTimeout(deadline);
          clearTimeout(interrupt);
          resolve(value);
        }
      };
      const req = (target.protocol === 'https:' ? https : http).request(
        target,
        { method, headers: { ...(auth ? { authorization: auth } : {}), ...headers } },
        (response) => {
          let bytes = 0,
            data = '';
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (data.length < 4096) data += chunk.toString();
          });
          response.on('end', () =>
            finish({
              status: response.statusCode,
              bytes,
              body: redact(data),
              headers: Object.fromEntries(
                ['server', 'cf-ray', 'cf-cache-status', 'content-type', 'www-authenticate']
                  .filter((key) => response.headers[key])
                  .map((key) => [key, response.headers[key]]),
              ),
              tls:
                target.protocol === 'https:'
                  ? { authorized: req.socket.authorized, protocol: req.socket.getProtocol() }
                  : null,
            }),
          );
          response.on('error', reject);
        },
      );
      const deadline = setTimeout(() => {
        req.destroy();
        finish({ deadline: true, status: null });
      }, 15_000);
      const interrupt =
        interruptMs === undefined
          ? undefined
          : setTimeout(() => {
              req.destroy();
              finish({ interrupted: true, status: null, sentBytes: body?.length ?? 0 });
            }, interruptMs);
      req.on('error', (error) => {
        if (!done && interruptMs === undefined) {
          clearTimeout(deadline);
          reject(error);
        }
      });
      if (interruptMs === undefined) req.end(body);
      else req.write(body);
    });
  }
  const ref = (name) => `refs/heads/${prefix}/${name}`;
  const push = (mappings, flags = [], captureTrace = false) =>
    textGit(
      local,
      [
        ...(flags[0] === '-c' ? flags : []),
        'push',
        '--porcelain',
        ...(flags[0] === '-c' ? [] : flags),
        remote,
        ...mappings,
      ],
      { captureTrace },
    );
  try {
    report.gitVersion = await textGit(out, ['--version']);
    const initial = await refs();
    report.initialRefCount = initial.size;
    assert.ok(
      ![...initial.keys()].some((name) => name.startsWith(`refs/heads/${prefix}/`)),
      'Choose a fresh run ID; this namespace already exists',
    );
    await test('public TLS and Basic authentication', async () => {
      const path = `/git/${projectId}.git/info/refs?service=git-upload-pack`;
      const good = await request(path),
        anonymous = await request(path, { auth: '' }),
        bad = await request(path, { auth: 'Basic bWVydjppbnZhbGlk' });
      assert.equal(good.status, 200);
      assert.equal(anonymous.status, 401);
      assert.equal(bad.status, 401);
      assert.match(String(anonymous.headers['www-authenticate']), /Basic/i);
      if (base.protocol === 'https:') assert.equal(good.tls.authorized, true);
      let wrong;
      if (wrongProjectId) {
        assert.match(wrongProjectId, /^[A-Za-z0-9_-]{1,200}$/);
        wrong = await request(`/git/${wrongProjectId}.git/info/refs?service=git-upload-pack`);
        assert.ok([403, 404].includes(wrong.status));
      }
      return {
        ingress: good.headers,
        tls: good.tls,
        anonymous: anonymous.status,
        invalidCredential: bad.status,
        wrongProject: wrong?.status,
      };
    });
    await test('ordinary clone, protocol v0 and v2, incremental commit push', async () => {
      await textGit(out, ['-c', 'protocol.version=2', 'clone', remote, local], {
        captureTrace: true,
      });
      await textGit(local, ['-c', 'protocol.version=0', 'ls-remote', remote]);
      await textGit(local, ['checkout', '-b', `${prefix}/main`]);
      await writeFile(join(local, 'native-git-acceptance.txt'), `${runId}\n`);
      await textGit(local, ['add', '.']);
      await textGit(local, ['commit', '-m', 'Public native Git acceptance']);
      const first = await textGit(local, ['rev-parse', 'HEAD']);
      await push([`HEAD:${ref('main')}`], [], true);
      assert.equal((await refs()).get(ref('main')), first);
      return { head: first };
    });
    const parent = await textGit(local, ['rev-parse', 'HEAD']);
    await test('reserved namespace ancestor is refused', async () => {
      await assert.rejects(push([`${parent}:refs/heads/merv`]));
      assert.equal((await refs()).get('refs/heads/merv'), initial.get('refs/heads/merv'));
      return {
        noResearchRefsInitially: ![...initial.keys()].some((name) =>
          name.startsWith('refs/heads/merv/'),
        ),
      };
    });
    await test('gzip upload-pack negotiation with sixty independent tips', async () => {
      const tree = await textGit(local, ['rev-parse', `${parent}^{tree}`]);
      const tips = new Map();
      for (let i = 0; i < 60; i++)
        tips.set(
          ref(`tips/${i}`),
          await textGit(local, [
            'commit-tree',
            tree,
            '-p',
            parent,
            '-m',
            `independent ${runId} ${i}`,
          ]),
        );
      await push([...tips].map(([name, oid]) => `${oid}:${name}`));
      const clone = join(out, 'gzip-checkout');
      await textGit(out, ['clone', remote, clone]);
      const next = new Map();
      for (const [name, oid] of tips)
        next.set(
          name,
          await textGit(local, ['commit-tree', tree, '-p', oid, '-m', `advance ${name}`]),
        );
      await push([...next].map(([name, oid]) => `${oid}:${name}`));
      const start = report.requests.length;
      await textGit(clone, ['fetch', 'origin'], { captureTrace: true });
      assert.ok(
        report.requests.slice(start).some((line) => /^content-encoding:\s*gzip$/i.test(line)),
        'Git did not send gzip negotiation',
      );
      for (const [name, oid] of next)
        assert.equal(
          await textGit(clone, ['rev-parse', name.replace('refs/heads/', 'refs/remotes/origin/')]),
          oid,
        );
      await textGit(clone, ['fsck', '--strict', '--no-dangling']);
      return { tips: next.size, gzipRequestObserved: true };
    });
    await test('large native HTTP/1.1 chunked push and fetched bytes', async () => {
      const data = randomBytes(largeMiB * 1024 ** 2),
        sha256 = createHash('sha256').update(data).digest('hex');
      await writeFile(join(local, 'transport-large.bin'), data);
      await textGit(local, ['add', 'transport-large.bin']);
      await textGit(local, ['commit', '-m', 'Chunked public transport']);
      const head = await textGit(local, ['rev-parse', 'HEAD']),
        start = report.requests.length;
      await push(
        [`HEAD:${ref('large')}`],
        ['-c', 'http.version=HTTP/1.1', '-c', 'http.postBuffer=16384', '-c', 'pack.compression=0'],
        true,
      );
      assert.ok(
        report.requests.slice(start).some((line) => /^transfer-encoding:\s*chunked$/i.test(line)),
        'Git did not send a chunked request',
      );
      const clone = join(out, 'large-checkout');
      await textGit(out, [
        'clone',
        '--single-branch',
        '--branch',
        `${prefix}/large`,
        remote,
        clone,
      ]);
      assert.equal(
        createHash('sha256')
          .update(await readFile(join(clone, 'transport-large.bin')))
          .digest('hex'),
        sha256,
      );
      return { head, bytes: data.length, sha256, chunkedRequestObserved: true };
    });
    await test('namespace collisions preserve actual Git outcomes and later health', async () => {
      let cases = 0;
      for (const descendantFirst of [false, true]) {
        const topic = ref(`existing-${descendantFirst}/topic`),
          existing = descendantFirst ? `${topic}/child` : topic;
        await push([`${parent}:${existing}`]);
        for (const atomic of [false, true]) {
          const bad = descendantFirst ? topic : `${topic}/child`,
            safe = ref(`existing-${descendantFirst}/safe-${atomic}`);
          await assert.rejects(
            push([`${parent}:${bad}`, `${parent}:${safe}`], atomic ? ['--atomic'] : []),
          );
          const actual = await refs();
          assert.equal(actual.get(existing), parent);
          assert.ok(!actual.has(bad));
          assert.equal(actual.get(safe), atomic ? undefined : parent);
          cases++;
        }
      }
      for (const reverse of [false, true])
        for (const atomic of [false, true]) {
          const a = ref(`within-${reverse}-${atomic}/topic`),
            pair = [a, `${a}/child`];
          if (reverse) pair.reverse();
          await assert.rejects(
            push(
              pair.map((name) => `${parent}:${name}`),
              atomic ? ['--atomic'] : [],
            ),
          );
          const actual = await refs();
          assert.equal(pair.filter((name) => actual.has(name)).length, atomic ? 0 : 1);
          cases++;
        }
      await push([`${parent}:${ref('after-collisions')}`]);
      return { cases };
    });
    await test('malformed requests do not poison the remote', async () => {
      const path = `/git/${projectId}.git/git-receive-pack`;
      const mime = await request(path, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('invalid'),
      });
      const packet = await request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-git-receive-pack-request' },
        body: Buffer.from('zzzz'),
      });
      const gzip = await request(`/git/${projectId}.git/git-upload-pack`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-git-upload-pack-request',
          'content-encoding': 'gzip',
        },
        body: Buffer.from('not gzip'),
      }).catch((error) => ({ error: error.code }));
      assert.equal(mime.status, 415);
      assert.ok(packet.status >= 400);
      assert.ok(
        gzip.status >= 400 ||
          ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(gzip.error) ||
          // Native http-backend may have emitted CGI headers before rejecting gzip.
          // A completed empty body is an invalid Git response; a deadline is not.
          (gzip.status === 200 && gzip.bytes === 0),
        `Malformed gzip did not return a protocol error: ${JSON.stringify(gzip)}`,
      );
      await refs();
      return {
        wrongMime: mime.status,
        malformedPacket: packet.status,
        malformedGzip: { status: gzip.status, bytes: gzip.bytes, error: gzip.error },
      };
    });
    await test('interrupted and timed-out chunked receives publish no ref', async () => {
      await writeFile(join(local, 'cancel.bin'), randomBytes(2 * 1024 ** 2));
      await textGit(local, ['add', 'cancel.bin']);
      await textGit(local, ['commit', '-m', 'Unpublished cancellation candidate']);
      const head = await textGit(local, ['rev-parse', 'HEAD']);
      const pack = await git(local, ['pack-objects', '--stdout', '--revs'], {
        input: `${head}\n^${parent}\n`,
      });
      assert.ok(pack.length > 256 * 1024);
      for (const [name, interruptMs] of [
        ['cancel', 100],
        ['deadline', 1000],
      ]) {
        const command = `${'0'.repeat(head.length)} ${head} ${ref(name)}\0report-status\n`;
        const body = Buffer.concat([
          Buffer.from(
            (Buffer.byteLength(command) + 4).toString(16).padStart(4, '0') + command + '0000',
          ),
          pack.subarray(0, 128 * 1024),
        ]);
        const result = await request(`/git/${projectId}.git/git-receive-pack`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-git-receive-pack-request' },
          body,
          interruptMs,
        });
        assert.equal(result.interrupted, true);
        let actual;
        const until = Date.now() + 30_000;
        for (;;) {
          try {
            actual = await refs();
            break;
          } catch (error) {
            if (Date.now() >= until) throw error;
            await delay(250);
          }
        }
        assert.ok(!actual.has(ref(name)));
      }
      await push([`${parent}:${ref('after-cancellation')}`]);
      return { interruptedTransfers: 2, publishedRefs: 0 };
    });
    await test('original history and subsequent fetch remain intact', async () => {
      const final = await refs();
      for (const [name, oid] of initial) assert.equal(final.get(name), oid, name);
      await textGit(local, ['fetch', 'origin']);
      await textGit(local, ['fsck', '--strict', '--no-dangling']);
      return {
        unchangedOriginalRefs: initial.size,
        probeRefs: [...final.keys()].filter((name) => name.startsWith(`refs/heads/${prefix}/`))
          .length,
      };
    });
    report.complete = true;
  } finally {
    report.finishedAt = new Date().toISOString();
    const encoded = JSON.stringify(report, null, 2) + '\n';
    assert.ok(
      !encoded.includes(token) && !encoded.includes(authorization),
      'Refusing to persist a credential',
    );
    await writeFile(join(out, 'report.json'), encoded, { mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2),
      options = {};
    const keys = {
      '--base-url': 'baseUrl',
      '--project': 'projectId',
      '--token-env': 'tokenEnv',
      '--out': 'out',
      '--run-id': 'runId',
      '--large-mib': 'largeMiB',
      '--wrong-project': 'wrongProjectId',
    };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--allow-local') {
        options.allowLocal = true;
        continue;
      }
      assert.ok(
        keys[args[i]] && args[i + 1] && !args[i + 1].startsWith('--'),
        'Usage: --base-url URL --project ID --token-env ENV --out DIR [--run-id ID] [--large-mib 1..32] [--wrong-project ID] [--allow-local]',
      );
      options[keys[args[i]]] = args[i] === '--large-mib' ? Number(args[++i]) : args[++i];
    }
    assert.ok(
      options.baseUrl && options.projectId && options.out,
      'Explicit base URL, project ID and output directory are required',
    );
    const report = await runProbe(options);
    console.log(
      JSON.stringify({
        complete: report.complete,
        projectId: report.projectId,
        checks: report.tests.length,
        report: join(resolve(options.out), 'report.json'),
      }),
    );
  } catch (error) {
    // Detailed diagnostics are sanitized inside the protected report, never dumped here.
    console.error(
      'Public Git probe failed; inspect its protected report.json. No project or key was removed.',
    );
    process.exitCode = 1;
  }
}
