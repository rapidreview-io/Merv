import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runNisaUnloadScenario } from './nisa-unload-scenario.js';

const directory = resolve(
  process.argv[2] ??
    join('live-runs', `nisa-unload-${new Date().toISOString().replaceAll(':', '-')}`),
);
mkdirSync(dirname(directory), { recursive: true });
// A failed rerun must never leave a previous success report at the requested output path.
mkdirSync(directory, { mode: 0o700 });
try {
  const report = await runNisaUnloadScenario(join(directory, 'data'), (item) =>
    console.log(JSON.stringify(item)),
  );
  const path = join(directory, 'report.json');
  writeFileSync(
    path,
    JSON.stringify({ ...report, completedAt: new Date().toISOString() }, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ status: 'passed', report: path }));
} catch {
  console.error('Nisa removal scenario failed. Run the focused test for assertion details.');
  process.exitCode = 1;
}
