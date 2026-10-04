import { readFileSync } from 'node:fs';
import { MachineRunner } from '@merv/runner';
import { CodeWorkspaceDriver } from '@merv/code/driver/index';

const runner = new MachineRunner(JSON.parse(readFileSync(process.argv[2], 'utf8')), {
  drivers: [
    {
      name: 'code.v2',
      create: (host, transport) => new CodeWorkspaceDriver(host, transport, { pollMs: 10 }),
    },
  ],
});
process.on('message', async (message) => {
  if (message === 'stop') {
    await runner.stop();
    process.exit(0);
  }
});
await runner.start();
process.send?.({ type: 'ready' });
