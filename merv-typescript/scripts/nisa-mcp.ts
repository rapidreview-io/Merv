import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runNisaMcpScenario } from './nisa-mcp-scenario.js';

const checkout = process.env.MERV_NISA_CHECKOUT;
if (!checkout) throw new Error('Set MERV_NISA_CHECKOUT to the prepared Nisa repository.');
const directory = resolve(
  process.argv[2] ?? join('live-runs', `nisa-mcp-${new Date().toISOString().replaceAll(':', '-')}`),
);
mkdirSync(dirname(directory), { recursive: true });
// An existing successful report must not survive a failed rerun under the same name.
mkdirSync(directory, { mode: 0o700 });
try {
  const report = await runNisaMcpScenario(join(directory, 'data'), checkout);
  const path = join(directory, 'report.json');
  writeFileSync(
    path,
    JSON.stringify({ ...report, completedAt: new Date().toISOString() }, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ status: 'passed', report: path }));
} catch {
  console.error('Nisa MCP composition failed. Run the focused test for assertion details.');
  process.exitCode = 1;
}
