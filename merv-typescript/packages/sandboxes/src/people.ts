import type { Context } from 'cordis';
import { digest, MervError, type Scope } from '@merv/contracts';
import type { SbxAccounts } from '@sandboxes/accounts';
import type { SbxAuth } from '@sandboxes/auth';
import type { CreditGrantInput, CreditScheduleInput, SbxBilling } from '@sandboxes/billing';
import { Decimal } from '@sandboxes/kernel';
import { mervRefusals } from '@sandboxes/merv-host/errors';
import type { SbxProviders } from '@sandboxes/providers';
import type { SandboxesPeople as People } from './types.js';

/** USD per provider that every person's own account is granted once, as decimal text. */
export type NewPersonCredits = Record<string, string>;
type Person = Parameters<People['ensure']>[0];

const refusals = mervRefusals(MervError);
const log = (record: object) => void process.stderr.write(`${JSON.stringify(record)}\n`);
const cause = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Merv's people in Sandboxes, which keeps the person, their account and its credits. */
export class SandboxesPeople implements People {
  #pending = new Set<Promise<void>>();
  #unconnected = new Set<string>();
  #closed = false;
  constructor(
    private readonly sbx: {
      auth: SbxAuth;
      accounts: SbxAccounts;
      billing: SbxBilling;
      providers: SbxProviders;
    },
    private readonly credits: NewPersonCredits,
  ) {}

  ensure({ issuer, subject, label }: Person): Promise<{ accountId: string }> {
    return refusals.call(async () => {
      const { persons } = this.sbx.auth;
      // A new person comes with their own account, them its admin, in their home namespace.
      const person =
        (await persons.byIdentity(issuer, subject)) ??
        (await persons.ensureIdentity({ issuer, subject, displayName: label }));
      const { account_id: accountId } = await this.sbx.accounts.namespace(person.home_namespace!);
      const offered = Object.entries(this.credits);
      if (!offered.length) return { accountId };
      const { credits } = this.sbx.billing;
      const granted = new Set((await credits.report(accountId)).grants.map((grant) => grant.id));
      const connected = new Set((await this.sbx.providers.connections.list()).map((c) => c.plugin));
      const key = digest([issuer, subject]).slice(0, 40);
      for (const [provider, usd] of offered) {
        const id = `welcome:${provider}:${key}`;
        if (granted.has(id)) continue;
        // CreditService refuses credits no operator connection can spend.
        if (!connected.has(provider)) {
          if (!this.#unconnected.has(provider))
            log({ event: 'sandboxes.people.credits_skipped', provider, reason: 'no_connection' });
          this.#unconnected.add(provider);
          continue;
        }
        // Fixed terms, so a concurrent ensure of this person grants the same grant.
        await this.#credit(accountId, provider, true, () =>
          credits.grant({
            id,
            accountId,
            provider,
            amount: Decimal.parse(usd),
            validFrom: person.created_at,
            expiresAt: null,
            reason: 'Welcome credits',
          }),
        );
      }
      return { accountId };
    });
  }

  accountOf({ issuer, subject }: Person) {
    return refusals.call(async () => {
      const person = await this.sbx.auth.persons.byIdentity(issuer, subject);
      if (!person?.home_namespace) return null;
      const { account_id } = await this.sbx.accounts.namespace(person.home_namespace);
      return { accountId: account_id, name: person.display_name || person.email || null };
    });
  }

  async grant(person: Person, input: Omit<CreditGrantInput, 'accountId'>): Promise<void> {
    const { accountId } = await this.ensure(person);
    await this.#credit(accountId, input.provider, true, () =>
      this.sbx.billing.credits.grant({ ...input, accountId }),
    );
  }

  async schedule(person: Person, input: Omit<CreditScheduleInput, 'accountId'>): Promise<void> {
    const { accountId } = await this.ensure(person);
    await this.#credit(accountId, input.provider, input.enabled, () =>
      this.sbx.billing.credits.setSchedule({ ...input, accountId }),
    );
  }

  /** The credit write, then the account's access to the provider's operator connections where
   *  no operator decided it yet. */
  #credit(accountId: string, provider: string, entitle: boolean, write: () => Promise<void>) {
    return refusals.call(async () => {
      await write();
      if (!entitle) return;
      const { connections } = this.sbx.providers;
      const decided = new Set(
        (await connections.listEntitlements({ accountId }))
          .filter((entitled) => entitled.scope === 'account')
          .map((entitled) => entitled.connection_id),
      );
      for (const { id, plugin } of await connections.list())
        if (plugin === provider && !decided.has(id))
          await connections.setEntitlement({ connectionId: id, accountId, enabled: true });
    });
  }

  /** In the background: a person's failure is logged and stops no one else. */
  signedIn(person: Person): void {
    if (!this.#closed) this.#track(this.#ensure(person));
  }
  /** Everyone already signed in, one at a time, once. */
  backfill(scope: Scope): void {
    this.#track(
      (async () => {
        for (const person of (await scope.directory()).people) {
          if (this.#closed) return;
          await this.#ensure(person);
        }
      })(),
    );
  }
  async settled(): Promise<void> {
    await Promise.all(this.#pending);
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.settled();
  }

  #ensure = (person: Person) =>
    this.ensure(person).then(
      () => {},
      (error) =>
        log({
          event: 'sandboxes.people.ensure_failed',
          subject: person.subject,
          cause: cause(error),
        }),
    );
  #track(work: Promise<void>): void {
    const running = work
      .catch((error) => log({ event: 'sandboxes.people.backfill_failed', cause: cause(error) }))
      .finally(() => this.#pending.delete(running));
    this.#pending.add(running);
  }
}

/** Every verified person gets their own Sandboxes account: at first sign-in, and at start for
 *  everyone signed in before. Loaded by the integration, which passes its `newPersonCredits`. */
export const sandboxesPeoplePlugin = {
  name: 'merv-sandboxes-people',
  inject: ['scope', 'sbxAuth', 'sbxAccounts', 'sbxBilling', 'sbxProviders'],
  apply(ctx: Context, config: { newPersonCredits: NewPersonCredits }) {
    ctx.effect(function* () {
      const people = new SandboxesPeople(
        {
          auth: ctx.sbxAuth,
          accounts: ctx.sbxAccounts,
          billing: ctx.sbxBilling,
          providers: ctx.sbxProviders,
        },
        config.newPersonCredits,
      );
      yield ctx.provide('sandboxesPeople', people);
      yield () => people.close();
      yield ctx.scope.members.onFirstSignIn((person) => people.signedIn(person));
      people.backfill(ctx.scope);
    });
  },
};
