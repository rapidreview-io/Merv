/** What the unload scenarios share: waiting on a condition, a JSON tool call, and the report. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { useRunSchema } from './database.js';

export async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}
/** A tool call that must succeed, answered by the JSON of its first text block. */
export async function callJson(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse((result.content as { text: string }[])[0].text);
}

/**
 * Runs a scenario in argv[2] or a new live-runs/<name>-<time> directory, on that run's own
 * schema, and writes its report.json there (with `mode`, when given). A failure sets the exit code
 * and prints `failed`, or, without it, writes failure.json and prints the error.
 */
export async function reportScenario(
  name: string,
  run: (directory: string, log: (item: unknown) => void) => Promise<object>,
  { mode, failed }: { mode?: number; failed?: string } = {},
) {
  const directory = resolve(
    process.argv[2] ??
      join('live-runs', `${name}-${new Date().toISOString().replaceAll(':', '-')}`),
  );
  const schema = useRunSchema(directory);
  mkdirSync(dirname(directory), { recursive: true });
  // A failed rerun must never leave a previous success report at the requested output path.
  mkdirSync(directory, { mode: 0o700 });
  const write = (file: string, value: object, mode?: number) =>
    writeFileSync(join(directory, file), JSON.stringify(value, null, 2) + '\n', { mode });
  try {
    const report = await run(join(directory, 'data'), (item) => console.log(JSON.stringify(item)));
    write('report.json', { ...report, schema, completedAt: new Date().toISOString() }, mode);
    console.log(JSON.stringify({ status: 'passed', report: join(directory, 'report.json') }));
  } catch (error) {
    process.exitCode = 1;
    if (failed !== undefined) return console.error(failed);
    const message = error instanceof Error ? error.message : String(error);
    write('failure.json', { status: 'failed', schema, message });
    console.error(error);
  }
}
