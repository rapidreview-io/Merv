/** Build the existing hosted Codex image, then pin a separately pushed digest. */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mervRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const executable = '/opt/merv/runtime/start-runner';
const sandboxFiles = [
  'deploy/cloudflare-sandbox/Dockerfile',
  'deploy/cloudflare-sandbox/entrypoint.sh',
  'deploy/cloudflare-sandbox/receive-bootstrap',
  'agent/bin/sandboxes-agent-linux-amd64',
  'control/src/merv_sandboxes/__init__.py',
  'control/src/merv_sandboxes/errors.py',
  ...['__init__', 'launcher', 'releases', 'receiver', 'assignment'].map(
    (name) => `control/src/merv_sandboxes/runtimes/${name}.py`,
  ),
];
const mervFiles = [
  'scripts/hosted-runner/package.mjs',
  'scripts/hosted-runner/build.mjs',
  'scripts/hosted-runner/Dockerfile',
  'scripts/hosted-runner/smoke-supervisor.ts',
  'packages/runner/src/supervisor.mjs',
  'package.json',
  'package-lock.json',
];

function command(program, args, cwd, capture = false) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} failed${capture ? `: ${(result.stderr ?? '').trim()}` : ''}`);
  }
  return capture ? result.stdout.trim() : undefined;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileHashes(root, files) {
  return Object.fromEntries(
    files.map((relative) => {
      const file = join(root, relative);
      if (!statSync(file).isFile()) throw new Error(`Not a regular file: ${file}`);
      return [relative, sha256(readFileSync(file))];
    }),
  );
}

function copyInputs(source, destination) {
  for (const relative of sandboxFiles) {
    const target = join(
      destination,
      relative === 'agent/bin/sandboxes-agent-linux-amd64'
        ? 'deploy/cloudflare-sandbox/bin/sandboxes-agent-linux-amd64'
        : relative,
    );
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, relative), target);
  }
}

function build(sandboxPath, outputPath, tag) {
  const sandbox = resolve(sandboxPath);
  const out = resolve(outputPath);
  if (!/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$/.test(tag)) throw new Error('Invalid image tag');
  if (!existsSync(join(sandbox, 'deploy/cloudflare-sandbox/Dockerfile'))) {
    throw new Error('Sandbox checkout is missing its Cloudflare Dockerfile');
  }
  if (existsSync(out)) throw new Error('Output directory already exists; use a fresh directory');
  const sourceHashes = {
    merv: fileHashes(mervRoot, mervFiles),
    sandboxes: fileHashes(sandbox, sandboxFiles),
  };
  mkdirSync(out, { recursive: true });
  const context = join(out, 'sandbox-context');
  const bundle = join(out, 'bundle');
  copyInputs(sandbox, context);
  command(process.execPath, ['scripts/hosted-runner/build.mjs', bundle], mervRoot);
  const bundleHashes = fileHashes(bundle, ['smoke-supervisor.mjs', 'supervisor.mjs', 'start']);
  const baseTag = `${tag}-base`;
  command(
    'docker',
    [
      'build',
      '--platform',
      'linux/amd64',
      '-f',
      join(context, 'deploy/cloudflare-sandbox/Dockerfile'),
      '-t',
      baseTag,
      context,
    ],
    mervRoot,
  );
  command(
    'docker',
    [
      'build',
      '--platform',
      'linux/amd64',
      '-f',
      join(mervRoot, 'scripts/hosted-runner/Dockerfile'),
      '--build-arg',
      `SANDBOX_IMAGE=${baseTag}`,
      '-t',
      tag,
      bundle,
    ],
    mervRoot,
  );
  const architecture = command(
    'docker',
    ['image', 'inspect', '--format', '{{.Architecture}}', tag],
    mervRoot,
    true,
  );
  if (architecture !== 'amd64') throw new Error('Built image is not linux/amd64');
  const hashLine = command(
    'docker',
    ['run', '--rm', '--platform', 'linux/amd64', '--entrypoint', 'sha256sum', tag, executable],
    mervRoot,
    true,
  );
  const match = /^([0-9a-f]{64})  \/opt\/merv\/runtime\/start-runner$/.exec(hashLine);
  if (!match) throw new Error('Could not verify the installed runner executable');
  const manifest = {
    schema: 'merv-hosted-image-build-v1',
    source: {
      mervRevision: command('git', ['rev-parse', 'HEAD'], mervRoot, true),
      sandboxesRevision: command('git', ['rev-parse', 'HEAD'], sandbox, true),
      hashes: sourceHashes,
    },
    bundleHashes,
    image: {
      platform: 'linux/amd64',
      baseTag,
      baseId: command(
        'docker',
        ['image', 'inspect', '--format', '{{.Id}}', baseTag],
        mervRoot,
        true,
      ),
      tag,
      id: command('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], mervRoot, true),
      executable,
      executableSha256: match[1],
    },
  };
  writeFileSync(join(out, 'build.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(`${join(out, 'build.json')}\n`);
}

function finalize(buildPath, registryImage, provider) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) throw new Error('Invalid provider');
  const match = /^.+@(sha256:[0-9a-f]{64})$/.exec(registryImage);
  if (!match) throw new Error('Registry image must have an immutable SHA-256 digest');
  const input = JSON.parse(readFileSync(buildPath, 'utf8'));
  const image = input.image;
  if (
    input.schema !== 'merv-hosted-image-build-v1' ||
    image?.platform !== 'linux/amd64' ||
    image.executable !== executable ||
    !/^[0-9a-f]{64}$/.test(image.executableSha256)
  ) {
    throw new Error('Invalid hosted image build manifest');
  }
  const release = {
    provider,
    image_digest: match[1],
    executable,
    executable_sha256: image.executableSha256,
    arguments: [],
    enrollment_timeout_seconds: 60,
  };
  // Exactly RuntimeRelease.release_id in merv-sandboxes/runtimes/releases.py.
  const identity = [
    'merv-runtime-release-v1',
    release.provider,
    release.image_digest,
    release.executable,
    release.executable_sha256,
    release.arguments,
    release.enrollment_timeout_seconds,
  ];
  const releaseId = `rt1_${sha256(JSON.stringify(identity))}`;
  const result = { releases: [release] };
  const directory = dirname(resolve(buildPath));
  writeFileSync(join(directory, 'releases.json'), JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600,
  });
  writeFileSync(
    join(directory, 'release.json'),
    JSON.stringify(
      {
        schema: 'merv-hosted-image-release-v1',
        buildManifest: resolve(buildPath),
        registryImage,
        releaseId,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  process.stdout.write(`${releaseId}\n`);
}

const [action, ...args] = process.argv.slice(2);
if (action === 'build' && args.length === 3) build(...args);
else if (action === 'finalize' && args.length === 3) finalize(...args);
else
  throw new Error(
    'Usage: package.mjs build <sandbox-checkout> <fresh-output-dir> <image-tag> | finalize <build.json> <registry-image@sha256:digest> <provider>',
  );
