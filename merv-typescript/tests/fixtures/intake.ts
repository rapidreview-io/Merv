import { CustomerService } from '../../packages/customer-experiments/src/service.js';
import type { PiProfile } from '../../packages/pi/src/types.js';
import type { Tools } from '../../packages/api/src/types.js';

/** Collect the real service's versioned definitions, without starting a customer project. */
export async function intakeProfiles(tools = { noun: () => () => {} } as unknown as Tools) {
  const profiles: PiProfile[] = [];
  const service = new CustomerService(
    {
      get: async () => ({ projectId: 'private-project', conversationId: 'private-conversation' }),
    } as never,
    {} as never,
    {} as never,
    { registerFileProvider: () => () => {} } as never,
    { registerProfile: (profile: PiProfile) => (profiles.push(profile), () => {}) } as never,
    undefined,
    () => undefined,
    undefined,
    {} as never,
  );
  const dispose = await service.registerIntake(tools);
  return { profiles, dispose };
}
