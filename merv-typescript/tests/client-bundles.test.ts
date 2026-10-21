import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { clientBundle } from '@merv/scope/client-bundle';
import { packageArchive, packageFiles, packageName } from '@merv/scope/client-package';
import { setupGuide } from '@merv/scope/setup';

test('published client bundle matches source and has one remote connection per client', () => {
  const root = new URL('../../clients/', import.meta.url);
  const names = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter(
      (p) =>
        /^(codex\/|claude-code\/|\.agents\/|\.claude-plugin\/)/.test(p) && /\.(json|md)$/.test(p),
    )
    .sort();
  assert.deepEqual(Object.keys(clientBundle).sort(), names);
  for (const name of names)
    assert.equal(clientBundle[name], readFileSync(new URL(name, root), 'utf8'), name);
  const codex = JSON.parse(clientBundle['codex/mcp.json']!);
  const claude = JSON.parse(clientBundle['claude-code/.mcp.json']!);
  for (const config of [codex, claude]) {
    assert.equal(Object.keys(config.mcpServers).length, 1);
    assert.equal(config.mcpServers.merv.url, 'https://experiments.rapidreview.io/mcp');
    assert.equal(config.mcpServers.merv.command, undefined);
    assert.equal(config.mcpServers.merv.headers, undefined);
  }
  assert.equal(codex.mcpServers.merv.extensions['com.openai'].auth.type, 'oauth');
  for (const name of ['research', 'operations', 'owners-agent'])
    assert.equal(
      clientBundle[`codex/skills/${name}/SKILL.md`],
      clientBundle[`claude-code/skills/${name}/SKILL.md`],
    );
});

test('downloadable tar contains only package files; staging uses distinct names and origin', () => {
  const origin = 'https://staging.example';
  const files = packageFiles(origin);
  const names = execFileSync('tar', ['-tzf', '-'], {
    input: packageArchive(origin),
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .sort();
  assert.deepEqual(names, Object.keys(files).sort());
  assert.notEqual(packageName(origin), 'merv');
  assert.equal(JSON.parse(files['codex/plugin.json']!).name, packageName(origin));
  assert.equal(JSON.parse(files['codex/mcp.json']!).mcpServers.merv.url, `${origin}/mcp`);
  assert.ok(!JSON.stringify(files).includes('experiments.rapidreview.io'));
  assert.match(setupGuide(origin), /Git repository\nis required|No Git repository/);
  assert.match(setupGuide(origin), /bundle.tar.gz/);
  assert.ok(!Object.keys(files).some((p) => /\.(sh|mjs)$/.test(p)));
});
