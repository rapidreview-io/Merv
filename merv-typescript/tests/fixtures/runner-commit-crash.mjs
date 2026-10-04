// Isolated local crash fixture: no remote API, credentials, or worker process.
import { readFileSync, writeFileSync } from 'node:fs';
import { LocalLedger } from '../../packages/runner/src/ledger.ts';
import { LocalWorkspaceDriver } from '../../packages/code/src/driver/local.ts';
import { ledgerHost } from '../../packages/runner/src/workspaces.ts';
const settings = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const ledger = new LocalLedger({ directory: settings.directory, binding: settings.binding });
const manager = new LocalWorkspaceDriver(ledgerHost(ledger), settings.config);
const original = manager.git.bind(manager);
manager.git = async (...args) => {
  const result = await original(...args);
  if (args[0].includes('commit-tree')) {
    writeFileSync(settings.observed, result);
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
  return result;
};
await manager.checkpointCommit(ledger.get(settings.launchId), settings.command);
throw new Error('The fixture failed to interrupt the commit');
