import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { check, createService } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import {
  hostMigration,
  migration,
  sendInput,
  toldMigration,
  usageMigration,
} from '../packages/pi/src/schema.js';
import { openState } from './fixtures/state.js';
import { fixture } from './fixtures/pi.js';

// PostgreSQL's jsonb refuses `\u0000` and a lone surrogate, which JSON text may hold.

test('pi@4 on a turn whose text holds a NUL character', async (t) => {
  // pi.send takes it as is, and Pi keeps the turn as JSON text.
  const text = sendInput.parse({ commandId: 'c1', text: 'see\u0000this' }).text;
  assert.ok(JSON.stringify({ text }).includes('\\u0000'));
  const state = await openState();
  t.after(() => state.close());
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.credentials.bootstrap({ projectName: 'Pi nul', actorName: 'Owner' });
  await state.migrate('pi', [migration, hostMigration, usageMigration]);
  await state.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO pi_conversations(id,project_id,user_id,request_id,input_hash,data_json) VALUES(?,?,?,?,?,?)',
      'pic_nul',
      boot.project.id,
      'user',
      'request',
      'hash',
      JSON.stringify({ id: 'pic_nul' }),
    );
    await tx.run(
      'INSERT INTO pi_commands(id,conversation_id,status,relay_hash,created_at,data_json) VALUES(?,?,?,?,?,?)',
      'c1',
      'pic_nul',
      'completed',
      'relay_c1',
      '2026-10-01T00:00:00Z',
      JSON.stringify({ id: 'c1', status: 'completed', messages: [{ role: 'user', text }] }),
    );
    // A receipt turn jsonb cannot read is skipped too, and the rest still migrates.
    await tx.run(
      'INSERT INTO pi_commands(id,conversation_id,status,relay_hash,created_at,data_json) VALUES(?,?,?,?,?,?)',
      'c2',
      'pic_nul',
      'completed',
      'relay_c2',
      '2026-10-01T00:00:01Z',
      JSON.stringify({ id: 'c2', messages: [{ role: 'user', text: 'Ran x: \ud800' }] }),
    );
  });
  await state.migrate('pi', [migration, hostMigration, usageMigration, toldMigration]);
});

test('Pi starts over a kept turn jsonb cannot read', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  await f.state.transaction((tx) =>
    tx.run(
      'INSERT INTO pi_commands(id,conversation_id,status,relay_hash,created_at,data_json) VALUES(?,?,?,?,?,?)',
      'c_nul',
      conversation.id,
      'completed',
      'relay_c_nul',
      '2026-10-01T00:00:00Z',
      JSON.stringify({
        id: 'c_nul',
        messages: [{ role: 'user', text: 'see\u0000this' }],
        proposals: [{ id: 'pip_1', name: 'x', ran: { at: '2026-10-01T00:00:00Z', ok: true } }],
      }),
    ),
  );
  await f.restart();
});

test('Pi keeps no NUL or lone surrogate, whoever words the text', async (t) => {
  const f = await fixture(t);
  // A person's words and a model's answer are refused at the door.
  await assert.rejects(f.begun(f.operator, 'see\u0000this'), /cannot contain NUL/);
  // A tool's own refusal is not, and Run keeps it as what it told the agent.
  t.after(
    f.tools.register({
      name: 'probe.nul',
      description: 'Refuses in words jsonb cannot read',
      conversation: 'propose',
      inputSchema: z.object({}).strict(),
      handler: () => check(false, 'forbidden', 'no\u0000pe \ud800', 403),
    }),
  );
  const bound = await f.begun(f.operator);
  await assert.rejects(
    f.pi.complete(bound.token, {
      ...f.completion(bound.input),
      messages: [{ role: 'assistant', text: 'answer \udc00' }],
    }),
    /well-formed Unicode/,
  );
  const { proposed } = (await f.pi.tool(bound.token, {
    ...bound.input,
    name: 'probe.nul',
    input: {},
  })) as { proposed: { id: string } };
  await f.pi.complete(bound.token, f.completion(bound.input));
  await f.pi.run(f.operator, {
    id: bound.input.conversationId,
    commandId: bound.input.commandId,
    proposalId: proposed.id,
  });
  const rows = await f.state.read((sql) =>
    sql.all<{ data_json: string }>('SELECT data_json FROM pi_commands'),
  );
  for (const row of rows) assert.doesNotMatch(row.data_json, /\\u0000|\\ud[89a-f]/i);
  const told = (await f.pi.snapshot(f.operator, bound.conversation.id)).commands[0]!.proposals![0]!
    .ran!.told;
  assert.equal(told, 'probe.nul was refused: nope \ufffd');
  await f.state.read((sql) => sql.all('SELECT data_json::jsonb FROM pi_commands'));
});
