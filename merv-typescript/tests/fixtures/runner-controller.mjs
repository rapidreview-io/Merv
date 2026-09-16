import { readFileSync } from 'node:fs';
import { MachineRunner } from '@merv/runner';

const runner = new MachineRunner(JSON.parse(readFileSync(process.argv[2], 'utf8')));
process.on('message', async (message) => {
  if (message === 'stop') {
    await runner.stop();
    process.exit(0);
  }
});
await runner.start();
process.send?.({ type: 'ready' });
