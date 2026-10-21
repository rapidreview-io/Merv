import { bootMaintenance } from '@merv/contracts/maintenance';
import type { Context } from 'cordis';
import { digest, MervError, type Scope } from '@merv/contracts';
import type { SbxAccounts } from '@sandboxes/accounts';
import { linkProject, type SbxAuth } from '@sandboxes/auth';
import type { CreditGrantInput, CreditScheduleInput, SbxBilling } from '@sandboxes/billing';
import { Decimal, type Clock, type Database } from '@sandboxes/kernel';
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
  /** Links run one at a time, in the order their admins changed. */
  #links = Promise.resolve();
  #unconnected = new Set<string>();
  #closed = false;
  constructor(
    private readonly sbx: {
      auth: SbxAuth;
      accounts: SbxAccounts;
      billing: SbxBilling;
      providers: SbxProviders;
      db: Database;
      clock: Clock;
    },
    private readonly credits: NewPersonCredits,
  ) {}

  ensure({ issuer, subject, label }: Person): Promise<{ accountId: string; personId: string }> {
    return refusals.call(async () => {
      const { persons } = this.sbx.auth;
      // A new person comes with their own account, them its admin, in their home namespace.
      const person =
        (await persons.byIdentity(issuer, subject)) ??
        (await persons.ensureIdentity({ issuer, subject, displayName: label }));
      const { account_id: accountId } = await this.sbx.accounts.namespace(person.home_namespace!);
      const own = { accountId, personId: person.id };
      // The hub registers a host's operator connection the first time a namespace lists its
      // providers, and CreditService admits credit (welcome or granted) only on a registered one.
      await this.sbx.providers.instances(person.home_namespace!);
      const offered = Object.entries(this.credits);
      if (!offered.length) return own;
      const { credits } = this.sbx.billing;
      const granted = new Set((await credits.report(accountId)).grants.map((grant) => grant.id));
      const connected = new Set(await this.fundable());
      const key = digest([issuer, subject]).slice(0, 40);
      for (const [provider, usd] of offered) {
        const id = `welcome:${provider}:${key}`;
        // CreditService refuses credits no operator connection can spend.
        if (!connected.has(provider)) {
          if (!this.#unconnected.has(provider))
            log({ event: 'sandboxes.people.credits_skipped', provider, reason: 'no_connection' });
          this.#unconnected.add(provider);
          continue;
        }
        // Fixed terms, so a concurrent ensure of this person grants the same grant; granted
        // before, its access is given again, where giving it failed then.
        await this.#credit(accountId, provider, true, async () => {
          if (granted.has(id)) return;
          await credits.grant({
            id,
            accountId,
            provider,
            amount: Decimal.parse(usd),
            validFrom: person.created_at,
            expiresAt: null,
            reason: 'Welcome credits',
          });
        });
      }
      return own;
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

  /** Connections, not `modes.of`'s funded: CreditService admits credit on a connected one. */
  fundable() {
    return refusals.call(async () =>
      [...new Set((await this.sbx.providers.connections.list()).map((c) => c.plugin))].sort(),
    );
  }

  /** The credit write, then the account's access to the provider's operator connections where
   *  no operator decided it yet. The credit stands once written: access that fails is logged. */
  #credit(accountId: string, provider: string, entitle: boolean, write: () => Promise<void>) {
    return refusals.call(async () => {
      await write();
      if (!entitle) return;
      const { connections } = this.sbx.providers;
      try {
        const decided = new Set(
          (await connections.listEntitlements({ accountId }))
            .filter((entitled) => entitled.scope === 'account')
            .map((entitled) => entitled.connection_id),
        );
        for (const { id, plugin } of await connections.list())
          if (plugin === provider && !decided.has(id))
            await connections.setEntitlement({ connectionId: id, accountId, enabled: true });
      } catch (error) {
        log({ event: 'sandboxes.people.access_failed', accountId, provider, cause: cause(error) });
      }
    });
  }

  /** In the background: a person's failure is logged and stops no one else. */
  signedIn(person: Person): void {
    // Authentication can occur before the HTTP maintenance refusal; backfill resumes this later.
    if (bootMaintenance.active) return;
    if (!this.#closed) this.#track(this.#ensure(person));
  }
  /** In the background, after the links asked before it: a failure is logged and stops none. */
  // A committed explicit admin/billing change owns this reconciliation. Do not discard it:
  // startup backfill intentionally leaves already-linked projects alone. During maintenance
  // HTTP admits such mutations only through the operator capability and normal authorization.
  adminChanged(projectId: string, admin: Person): void {
    if (!this.#closed) this.#link(() => this.#linked(projectId, admin));
  }
  /** Everyone already signed in, one at a time, once; then every project with an admin and no
   *  link yet. One linked already stays where someone put it. */
  backfill(scope: Scope): void {
    if (bootMaintenance.active) return;
    this.#track(
      (async () => {
        for (const person of (await scope.directory()).people) {
          if (this.#closed) return;
          await this.#ensure(person);
        }
      })(),
    );
    this.#link(async () => {
      for (const { projectId, source } of await scope.projectOwners())
        if (source.kind === 'human' && !this.#closed) await this.#linked(projectId, source, true);
    });
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
  /** The project in its admin's own account, which pays for its compute: left alone where it
   *  is there already (or, `onlyUnlinked`, anywhere); moved there from another account with its
   *  namespace, which revokes the tokens minted for it there (its agents reconnect on their next
   *  lease). A failure is logged. */
  #linked = async (projectId: string, admin: Person, onlyUnlinked = false) => {
    try {
      const { accounts, db, clock } = this.sbx;
      const before = await accounts.linked(projectId);
      if (before && onlyUnlinked) return;
      const { accountId, personId } = await this.ensure(admin);
      if (before?.account_id === accountId) return;
      // Scope decided the admin: the host moves the project without an admin of its old account.
      await linkProject(
        { db, accounts, clock },
        personId,
        projectId,
        { account_id: accountId, only_unlinked: onlyUnlinked },
        { internal: true },
      );
      if (before)
        log({
          event: 'sandboxes.projects.relinked',
          projectId,
          from: before.account_id,
          accountId,
        });
    } catch (error) {
      log({ event: 'sandboxes.projects.link_failed', projectId, cause: cause(error) });
    }
  };
  #link(work: () => Promise<void>): void {
    const next = this.#links.then(work);
    this.#links = next.catch(() => {});
    this.#track(next);
  }
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
  inject: ['scope', 'sbxAuth', 'sbxAccounts', 'sbxBilling', 'sbxProviders', 'sbxDb', 'sbxClock'],
  apply(ctx: Context, config: { newPersonCredits: NewPersonCredits }) {
    ctx.effect(function* () {
      const people = new SandboxesPeople(
        {
          auth: ctx.sbxAuth,
          accounts: ctx.sbxAccounts,
          billing: ctx.sbxBilling,
          providers: ctx.sbxProviders,
          db: ctx.sbxDb,
          clock: ctx.sbxClock,
        },
        config.newPersonCredits,
      );
      yield ctx.provide('sandboxesPeople', people);
      yield () => people.close();
      yield ctx.scope.members.onFirstSignIn((person) => people.signedIn(person));
      yield ctx.scope.members.onAdminChanged((id, admin) => people.adminChanged(id, admin));
      people.backfill(ctx.scope);
    });
  },
};
