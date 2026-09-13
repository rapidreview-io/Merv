import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context, FiberState } from 'cordis';
import { SqliteState, statePlugin } from '@merv/state';

function malformedSchema(t: TestContext, closeError?: Error) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-state-lifecycle-'));
  const path = join(directory, 'state.sqlite');
  const fixture = new DatabaseSync(path);
  fixture.exec('CREATE TABLE events (id INTEGER PRIMARY KEY);');
  fixture.close();

  const exec = DatabaseSync.prototype.exec;
  const close = DatabaseSync.prototype.close;
  let acquired: DatabaseSync | undefined;
  let initializationError: unknown;
  const closed: DatabaseSync[] = [];
  const execMock = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      acquired ??= this;
      try {
        return exec.call(this, sql);
      } catch (error) {
        initializationError ??= error;
        throw error;
      }
    },
  );
  const closeMock = t.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync) {
    close.call(this);
    closed.push(this);
    if (closeError) throw closeError;
  });
  t.after(() => {
    try {
      // Keep the regression test itself from leaking a handle against the old implementation.
      if (acquired && !closed.includes(acquired)) close.call(acquired);
      rmSync(directory, { recursive: true, force: true });
    } finally {
      execMock.mock.restore();
      closeMock.mock.restore();
    }
  });
  return {
    path,
    closed,
    get acquired() {
      return acquired;
    },
    get initializationError() {
      return initializationError;
    },
  };
}

test('failed SQLite schema initialization closes its acquired handle and preserves the SQLite error', (t) => {
  const fixture = malformedSchema(t);
  assert.throws(
    () => new SqliteState(fixture.path),
    (error: unknown) => {
      assert.equal(error, fixture.initializationError);
      assert.match((error as Error).message, /project_id/);
      return true;
    },
  );
  assert.ok(fixture.acquired, 'The failure must occur after SQLite acquired a handle');
  assert.deepEqual(fixture.closed, [fixture.acquired]);
  assert.throws(() => fixture.acquired!.prepare('SELECT 1'), /not open/);
});

test('an error during failed-initialization cleanup does not replace the original initialization error', (t) => {
  const cleanupError = new Error('Injected close failure');
  const fixture = malformedSchema(t, cleanupError);
  assert.throws(
    () => new SqliteState(fixture.path),
    (error: unknown) => {
      assert.equal(error, fixture.initializationError);
      assert.notEqual(error, cleanupError);
      return true;
    },
  );
  assert.deepEqual(fixture.closed, [fixture.acquired]);
  assert.throws(() => fixture.acquired!.prepare('SELECT 1'), /not open/);
});

test('failed Cordis State activation closes the database before publishing a service', async (t) => {
  const fixture = malformedSchema(t);
  const ctx = new Context();
  t.mock.method(ctx.logger, 'error', () => undefined);
  try {
    const fiber = ctx.plugin(statePlugin, { path: fixture.path });
    await assert.rejects(fiber.await(), (error: unknown) => error === fixture.initializationError);
    assert.equal(fiber.state, FiberState.FAILED);
    assert.equal(ctx.get('state'), undefined);
    assert.deepEqual(fixture.closed, [fixture.acquired]);
    await ctx.fiber.dispose();
    assert.equal(fixture.closed.length, 1, 'Disposal must not close the failed provider twice');
  } finally {
    await ctx.fiber.dispose();
  }
});
