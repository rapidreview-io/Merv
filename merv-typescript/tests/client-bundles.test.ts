import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './fixtures/app.js';

const clients = new URL('../../clients/', import.meta.url);
const json = (path: string) => JSON.parse(readFileSync(new URL(path, clients), 'utf8'));
const manifest = json('manifest.json');
const skillsOf = (bundle: string) =>
  Object.fromEntries(
    readdirSync(new URL(`${bundle}/skills/`, clients)).map((name) => [
      name,
      readFileSync(new URL(`${bundle}/skills/${name}/SKILL.md`, clients), 'utf8'),
    ]),
  );
/** Named by a skill but absent from the committed composition: Pi registers record.look, and
 *  production adds Fleet and Sandboxes (deploy/render-config.mjs). project.brief is being added. */
const elsewhere = new Set([
  // project.list is answered by the MCP route itself; connector.* by the local connector.
  'project.list',
  'connector.login',
  'connector.status',
  'record.look',
  'project.brief',
  'fleet.list',
  'fleet.get',
  'fleet.drain',
  'fleet.halt',
  'sandboxes.sandbox_list',
  'sandboxes.sandbox_get',
  'sandboxes.providers_list',
  'sandbox.release',
]);

test('both client bundles say what the manifest says, with the same skills and no server', () => {
  const { name, version, description } = manifest;
  for (const path of ['claude-code/.claude-plugin/plugin.json', 'codex/.codex-plugin/plugin.json'])
    assert.deepEqual({ ...json(path) }, { ...json(path), name, version, description }, path);
  // The connector, which /connect installs, is the one registration: a plugin's own server
  // would list every tool twice.
  assert.match(manifest.connect, /\/connect$/);
  for (const bundle of ['claude-code', 'codex'])
    assert.equal(existsSync(new URL(`${bundle}/.mcp.json`, clients)), false, bundle);
  assert.equal(json('codex/.codex-plugin/plugin.json').mcpServers, undefined);
  const skills = skillsOf('claude-code');
  assert.deepEqual(Object.keys(skills).sort(), [...manifest.skills].sort());
  assert.deepEqual(skillsOf('codex'), skills, 'codex/skills is a copy of claude-code/skills');
  for (const [skill, text] of Object.entries(skills)) {
    assert.match(text, new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---\\n`), skill);
    assert.ok(text.split('\n').length <= 120, `${skill} is under 120 lines`);
  }
});

test('every tool a skill names is registered', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-clients-'));
  const app = await createApp({ directory, api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const registered = new Set((await app.ctx.tools.list()).map((tool) => tool.name));
  const named = Object.values(skillsOf('claude-code')).flatMap((text) =>
    [...text.matchAll(/`([a-z_]+(?:\.[a-z_]+)+)`/g)].map((match) => match[1]!),
  );
  assert.ok(named.length > 30);
  assert.deepEqual(
    [...new Set(named)].filter((name) => !registered.has(name) && !elsewhere.has(name)),
    [],
  );
});
