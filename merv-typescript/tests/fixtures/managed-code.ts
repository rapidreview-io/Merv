import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Caller } from '@merv/contracts';
import type { Code } from '@merv/code-work/types';

/** Await the real project-created consumer and Git journal, without bypassing admission. */
export async function waitForManagedCode(code: Pick<Code, 'status'>, caller: Caller) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const status = await code.status(caller);
    if (status.project?.main.stored) return status;
    assert.ok(Date.now() < deadline, JSON.stringify(status.operations));
    await delay(25);
  }
}
