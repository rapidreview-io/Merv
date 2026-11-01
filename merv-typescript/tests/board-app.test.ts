import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileGrants, restricted } from '@merv/pi/profile-tools';
import { piInstructions, turnNotes } from '@merv/pi/prompt';
import { voiceInstructions } from '@merv/pi/voice';
import { surface } from '@merv/board-app/words';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';
import { stateConfig } from './fixtures/state.js';

/** What the board app must never say to its agent: Merv's work, and Merv itself. */
const MERV =
  /\b(merv|tasks?|experiments?|sandbox(es)?|fleets?|projects?|artifacts?|papers?|records?|workers?|sessions?|reviews?|machines?|research)\b/i;
const composition = JSON.parse(
  readFileSync(new URL('../config/board.json', import.meta.url), 'utf8'),
) as ApplicationConfig;

test('the board app boots on its own plugins and tells Pi nothing of Merv', async (t) => {
  process.env.MERV_PI_MODEL_API_KEY = 'unused';
  const directory = mkdtempSync(join(tmpdir(), 'merv-board-app-'));
  const plugins = composition.plugins.map((entry) =>
    entry.id === 'state' ? { ...entry, config: stateConfig(directory) } : entry,
  );
  const app = await createApp({ directory, config: { plugins }, port: 0 });
  t.after(() => app.stop());
  const { ctx } = app;
  const names = app.status().map((entry) => entry.name);
  for (const gone of ['tasks', 'experiments', 'sessions', 'workflows', 'artifacts', 'sandboxes'])
    assert.ok(!names.includes(`@merv/${gone}`), gone);
  assert.ok(app.status().every((entry) => entry.state === 'active'));

  const prompt = piInstructions(ctx.tools.instructions(), surface);
  assert.doesNotMatch(prompt, MERV, 'instructions');
  assert.doesNotMatch(surface.voice(voiceInstructions), MERV, 'voice');
  const notes = turnNotes({
    role: 'operator',
    actorId: 'a',
    projectId: 'p',
    model: { id: 'm', label: 'M' },
    today: '2026-11-01',
    serves: surface.serves,
  });
  assert.doesNotMatch(notes.join(' '), MERV, 'notes');

  const person = await ctx.scope.credentials.bootstrap({ projectName: 'Mine', actorName: 'Me' });
  const caller = { actorId: person.actor.id, projectId: person.project.id };
  const grants = profileGrants(surface.tools, ctx.tools);
  const offered = (await ctx.tools.describe(caller, false, { names: [...grants.keys()] }))
    .filter(({ name }) => grants.has(name))
    .map((tool) => surface.tool(restricted(tool, grants.get(tool.name))));
  // screen.read is offered to conversations alone; a turn's offer is what pi.prompt shows.
  assert.deepEqual(offered.map(({ name }) => name).sort(), ['board.read', 'board.write']);
  const screen = surface.tool({ name: 'screen.read', description: 'x', inputSchema: {} } as never);
  assert.doesNotMatch(JSON.stringify(screen), MERV, 'screen.read');
  for (const tool of offered) {
    const said = [...JSON.stringify(tool).matchAll(new RegExp(MERV, 'gi'))].map(({ index }) =>
      JSON.stringify(tool).slice(Math.max(0, index - 40), index + 40),
    );
    assert.deepEqual(said, [], tool.name);
  }
  assert.doesNotMatch(JSON.stringify(offered), /"image"/, 'the image operation needs files');
});
