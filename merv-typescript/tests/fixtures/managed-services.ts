import { CodeService as CoreCodeService } from '@merv/code/service';
import { join } from 'node:path';
import {
  createService,
  type Artifacts,
  type Caller,
  type Scope,
  type State,
  type Workflows,
} from '@merv/contracts';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { CodeService } from '@merv/code-research/service';

/** Real Code storage for isolated owner-service tests of new-work creation. */
export async function managedServices(
  host: { state: State; scope: Scope; artifacts: Artifacts; workflows: Workflows },
  directory: string,
  caller: Caller,
) {
  const events = await createService(new DurableEvents(host.state));
  const sessions = await createService(
    new LeasedSessions(host.state, host.scope, host.workflows, events),
  );
  const core = await createService(
    new CoreCodeService(host.state, host.scope, {
      repositories: {
        root: join(directory, 'code'),
        quotaBytes: 10 * 1024 ** 3,
        reservedFreeBytes: 1,
      },
    }),
  );
  const code = await createService(
    new CodeService(host.state, host.scope, sessions, host.artifacts, host.workflows, core),
  );
  await host.state.transaction((tx) => code.ensureRepository(caller, tx));
  await (code as unknown as { store: { maintain(): Promise<void> } }).store.maintain();
  return {
    code,
    async close() {
      await code.close();
      await core.close();
      await sessions.close();
      await events.close();
    },
  };
}
