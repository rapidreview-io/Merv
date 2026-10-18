import type { Context } from 'cordis';
import { z, type ZodType, type ZodTypeDef } from 'zod';
import type {} from '@sandboxes/billing';
import type {} from '@sandboxes/providers';
import { PLUGIN_COPY } from '@sandboxes/providers/console-labels';
import { Decimal, Instant } from '@sandboxes/kernel';
import { mervRefusals } from '@sandboxes/merv-host';
import { check, MervError, pathSegment, type PlatformDirectory } from '@merv/contracts';
import type { ApiRequest } from '@merv/api/types';
import { personKey } from '@merv/fleet/model-ledger';
import type { PersonUse } from '@merv/fleet/types';
import type {} from '@merv/pi/types';
import type {} from '@merv/sandboxes/types';
import type {
  AdminCredits,
  CreditKind,
  CreditLimitInput,
  CreditUse,
  PersonCredits,
} from './models.js';
import { personLabel, type AdminEnv, type AdminRoute, type AdminRoutes } from './index.js';

const refusals = mervRefusals(MervError);
/** Syntax alone: CreditService refuses the values, but an amount it cannot parse would be a 500.
 *  `person` (`issuer|subject`) is whose own account it is on. */
const terms = {
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  person: z.string().min(1),
  provider: z.string(),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
};
const time = z.string().datetime({ offset: true });
/** `id` is the grant's own, and its idempotency key: reused, it must repeat the same terms. */
const grantInput = z
  .object({ ...terms, validFrom: time, expiresAt: time.nullable().optional(), reason: z.string() })
  .strict();
/** Terms are immutable: the same `id` only enables or disables the schedule. */
const scheduleInput = z
  .object({
    ...terms,
    cadence: z.enum(['daily', 'weekly', 'monthly']),
    startsAt: time,
    validityPeriods: z.number().int().nullable(),
    endsAt: time.nullable().optional(),
    enabled: z.boolean(),
  })
  .strict();
/** A daily limit within what its owner's own setting takes; null clears the person's own. */
const limitInput: ZodType<CreditLimitInput, ZodTypeDef, unknown> = z.union([
  z
    .object({
      kind: z.enum(['agent-tokens', 'fleet-tokens']),
      limit: z.number().int().min(1).max(1_000_000_000).nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal('fleet-usd'), limit: z.number().positive().max(100_000).nullable() })
    .strict(),
]);

/** The Sandboxes services credits live in, and the bridge to each person's own account, found
 *  per request: without them, 503. */
function sandboxes(ctx: Context) {
  const billing = ctx.get('sbxBilling');
  const providers = ctx.get('sbxProviders');
  const people = ctx.get('sandboxesPeople');
  check(
    billing && providers && people,
    'credits_unavailable',
    'Sandbox credits are not available on this server',
    503,
  );
  return { billing, providers, people };
}
type Sandboxes = ReturnType<typeof sandboxes>;
/** Provider plugins with an operator connection: the only providers credits may name. */
const connected = async (sbx: Sandboxes) =>
  [...new Set((await sbx.providers.connections.list()).map((c) => c.plugin))].sort();

type Person = PlatformDirectory['people'][number];
/** Fleet and Pi key a person by their sign-in; the actor names only callers without one. */
const keyOf = (person: Person) => personKey(person, { projectId: '', actorId: '' });
/** The person a route or a body names as `issuer|subject`, from Scope's directory. */
async function named(env: AdminEnv, key: string): Promise<Person> {
  const person = (await env.ctx.scope.directory()).people.find(
    ({ issuer, subject }) => `${issuer}|${subject}` === key,
  );
  check(person, 'not_found', 'Person not found', 404);
  return person;
}
/** The person `/admin/credits/people/:person` names: an issuer is a URL, so it holds `/`. */
function segment(r: ApiRequest) {
  try {
    return decodeURIComponent(r.url.pathname.split('/')[4]!);
  } catch {
    throw new MervError('invalid_input', 'Malformed person');
  }
}
type Window = keyof CreditUse['used'];
type Span = readonly [window: Window, from: string, to: string];
const DAY = 86_400_000;
/** The drawer's windows as UTC days [from, to): today first, the last 7 days, the last 30, all. */
function spans(now = Date.now()): Span[] {
  const day = (offset: number) =>
    new Date(now - (now % DAY) + offset * DAY).toISOString().slice(0, 10);
  return [
    ['day', day(0), day(1)],
    ['week', day(-6), day(1)],
    ['month', day(-29), day(1)],
    ['total', '1970-01-01', day(1)],
  ];
}
/**
 * Each person's use of every credit type in each window, read from its owner, with their own
 * Sandboxes account's grants and schedules. An owner not loaded leaves its types out; a provider
 * is listed where the account holds its credit or the operator connected it.
 */
async function uses(
  env: AdminEnv,
  sbx: Sandboxes,
  people: readonly Person[],
  windows: readonly Span[],
  providers: readonly string[],
): Promise<PersonCredits[]> {
  const keys = people.map(keyOf);
  /** An owner's reading of every person in every window, by person, then window. */
  const read = async <T>(of?: (from: string, to: string) => Promise<T[]>) => {
    const all = of && (await Promise.all(windows.map(([, from, to]) => of(from, to))));
    return all && keys.map((_, i) => all.map((rows) => rows[i]!));
  };
  const pi = env.ctx.get('pi');
  const fleet = env.ctx.get('fleet');
  const agent = await read(pi && ((from, to) => pi.tokensUsed(keys, from, to)));
  const machines = await read(fleet && ((from, to) => fleet.peopleUsage(keys, from, to)));
  const at = (day: string) => Instant.parseIso(`${day}T00:00:00Z`);
  /** A credit type from its owner's reading in each window, if it has one. The limit is now's;
   *  what is left is of today's limit unless the owner says (`left`). */
  const kind = (
    kind: CreditKind,
    label: string,
    unit: CreditUse['unit'],
    reads?: PersonUse<number | null>[],
    left?: number,
  ): CreditUse[] => {
    if (!reads) return [];
    const { limit, own, used } = reads[0]!;
    // Only the windows asked for: the list asks for today alone.
    const by = Object.fromEntries(windows.map(([w], n) => [w, reads[n]!.used]));
    const rest = limit === null ? null : Math.max(0, limit - used);
    return [{ kind, label, unit, limit, own, used: by as CreditUse['used'], left: left ?? rest }];
  };
  return await Promise.all(
    people.map(async (person, i) => {
      const own = await sbx.people.accountOf(person);
      const held =
        own &&
        (await sbx.billing.credits.usage(
          own.accountId,
          windows.map(([, from, to]) => [at(from), at(to)] as const),
        ));
      const pools = new Map(held ? held.pools.map((pool) => [pool.provider, pool]) : []);
      const rented = machines?.[i];
      const metered = rented?.[0]!.tokens ? rented.map((use) => use.tokens!) : undefined;
      return {
        person: {
          key: `${person.issuer}|${person.subject}`,
          label: personLabel(env.admins, person) ?? own?.name ?? 'Unnamed',
        },
        kinds: [
          ...kind('agent-tokens', 'Agent tokens', 'tokens', agent?.[i]),
          ...kind('fleet-tokens', 'Fleet agent tokens', 'tokens', metered),
          ...kind(
            'fleet-usd',
            'Fleet machines',
            'usd',
            rented?.map((use) => use.usd),
          ),
          ...[...new Set([...pools.keys(), ...providers])].sort().flatMap((provider) => {
            const pool = pools.get(provider);
            const granted = Number(pool?.granted ?? 0);
            const reads = windows.map((_, n) => ({
              used: Number(pool?.used_in[n] ?? 0),
              limit: granted,
              own: false,
            }));
            const label = PLUGIN_COPY[provider]?.title ?? provider;
            return kind(`provider:${provider}`, label, 'usd', reads, Number(pool?.available ?? 0));
          }),
        ],
        grants: held ? held.grants : [],
        schedules: held ? held.schedules : [],
      };
    }),
  );
}

async function credits(env: AdminEnv): Promise<AdminCredits> {
  const sbx = sandboxes(env.ctx);
  const { people } = await env.ctx.scope.directory();
  const rows = await uses(env, sbx, people, spans().slice(0, 1), await connected(sbx));
  return {
    people: rows.map(({ person, kinds }) => ({
      ...person,
      kinds: kinds.map(({ used, ...kind }) => ({ ...kind, used: used.day })),
    })),
  };
}

/** Writes go through each owner alone, and each is kept in the admin audit log. */
export function creditRoutes(env: AdminEnv): AdminRoutes {
  /** A credit write whose body names its own id and the person on whose own account it is, kept
   *  through the bridge, which gives them access to spend it: done, it answers that id. */
  const write =
    <T extends { id: string; person: string }>(
      action: string,
      input: ZodType<T, ZodTypeDef, unknown>,
      apply: (sbx: Sandboxes, person: Person & { label?: string }, body: T) => Promise<void>,
    ): AdminRoute =>
    async (r, who) => {
      const sbx = sandboxes(env.ctx);
      const body = await r.json(input);
      const person = await named(env, body.person);
      await apply(sbx, { ...person, label: personLabel(env.admins, person) }, body);
      await env.audit.record(who, action, body.person, body);
      return { id: body.id };
    };
  const instant = (at: string | null | undefined) => (at ? Instant.parseIso(at) : null);
  return {
    'GET /admin/credits': async () => await refusals.call(() => credits(env)),
    'GET /admin/credits/people/:person': async (r) => {
      const sbx = sandboxes(env.ctx);
      const person = await named(env, segment(r));
      return await refusals.call(async () => {
        const [found] = await uses(env, sbx, [person], spans(), await connected(sbx));
        return found!;
      });
    },
    // Each limit is its owner's own, which its owner enforces.
    'POST /admin/credits/people/:person/limits': async (r, who) => {
      const person = await named(env, segment(r));
      const input = await r.json(limitInput);
      const [pi, fleet] = [env.ctx.get('pi'), env.ctx.get('fleet')];
      const set =
        input.kind === 'agent-tokens'
          ? pi && (() => pi.setTokenLimit(keyOf(person), input.limit))
          : fleet &&
            (() =>
              fleet.setPersonLimit(
                keyOf(person),
                input.kind === 'fleet-usd' ? 'usd' : 'tokens',
                input.limit,
              ));
      check(set, 'credits_unavailable', 'That credit is not kept on this server', 503);
      await set();
      await env.audit.record(who, 'credits.limit', `${person.issuer}|${person.subject}`, {
        ...input,
      });
      return input;
    },
    'POST /admin/credits/grants': write('credits.grant', grantInput, (sbx, person, input) =>
      sbx.people.grant(person, {
        ...input,
        amount: Decimal.parse(input.amount),
        validFrom: Instant.parseIso(input.validFrom),
        expiresAt: instant(input.expiresAt),
      }),
    ),
    'POST /admin/credits/schedules': write(
      'credits.schedule',
      scheduleInput,
      (sbx, person, input) =>
        sbx.people.schedule(person, {
          ...input,
          amount: Decimal.parse(input.amount),
          startsAt: Instant.parseIso(input.startsAt),
          endsAt: instant(input.endsAt),
        }),
    ),
    'POST /admin/credits/grants/:id/revoke': async (r, who) => {
      const sbx = sandboxes(env.ctx);
      const grant = pathSegment(r.url.pathname.split('/')[4]!);
      await refusals.call(() => sbx.billing.credits.revokeGrant(grant));
      await env.audit.record(who, 'credits.revoke', grant);
      return { id: grant };
    },
  };
}
