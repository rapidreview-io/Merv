/** A killable production relay/ledger process for the settlement crash regression. */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Blobs, Scope } from '@merv/contracts';
import type { Tools } from '@merv/api/types';
import type { Fleet, ModelRelayConfig } from '@merv/fleet/types';
import type { ManagedModelGrant, Sessions } from '@merv/sessions/types';
import { PostgresState } from '@merv/state';
import { ModelRelay } from '../../packages/fleet/src/model-relay.js';
import { codexModelRelay } from '../../packages/fleet/src/codex-relay.js';
import { PiService } from '../../packages/pi/src/service.js';
import { piModelRelay } from '../../packages/pi/src/relay.js';
import type { PiModelCharge, PiRelayGrant } from '../../packages/pi/src/types.js';

process.once(
  'message',
  async (input: {
    schema: string;
    owner: 'fleet' | 'pi';
    boundary: 'beforeCommit' | 'afterCommit';
    grant: ManagedModelGrant & PiRelayGrant;
  }) => {
    const state = await PostgresState.open({
      connectionString: process.env.MERV_TEST_POSTGRES_URL!,
      schema: input.schema,
      maxConnections: 2,
      readConnections: 1,
    });
    const { grant } = input;
    let config: ModelRelayConfig<typeof grant, string, PiModelCharge>;
    if (input.owner === 'fleet') {
      config = codexModelRelay(
        { managedModelGrant: async () => grant } as unknown as Sessions,
        state,
        {
          providerKey: () => 'test-only-key',
          dailyTokensPerPerson: 100_000_000,
        },
      ) as typeof config;
    } else {
      const pi = new PiService(state, {} as Scope, {} as Fleet, {} as Tools, {} as Blobs);
      const { person: _person, allocationId: _allocation, effort: _effort, ...piGrant } = grant;
      config = piModelRelay({
        enabled: true,
        models: [{ id: grant.model, effort: 'none' }],
        providerKey: () => 'test-only-key',
        authority: { authorize: async () => piGrant, validate: async () => {} },
        reserve: (g, b) => pi.reserveModel(g, b),
        onUsage: (r, g, c) => pi.settleModel(r, g, c),
      }) as typeof config;
    }
    const waitForKill = async (charge: PiModelCharge) => {
      process.send!({ stage: 'settlement', charge });
      await new Promise<void>(() => {});
    };
    const relay = new ModelRelay({
      ...config,
      onFailure: () => {},
      onTerminal: () => {},
      fetchImpl: async () =>
        new Response(
          'event: response.created\ndata: {}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":23,"output_tokens":11}}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      onUsage: async (record, g, charge) => {
        if (input.boundary === 'beforeCommit') {
          const transaction = state.transaction.bind(state);
          // Both SQL writes have executed, but COMMIT has not. SIGKILL must roll both back.
          state.transaction = (fn) =>
            transaction(async (tx) => {
              const result = await fn(tx);
              await waitForKill(charge);
              return result;
            });
        }
        await config.onUsage!(record, g, charge);
        await waitForKill(charge);
      },
    });
    const server = createServer((req, res) => void relay.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.send!({
      stage: 'ready',
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${config.route}`,
    });
  },
);
