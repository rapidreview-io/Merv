import type {} from 'cordis';
import type { CreditGrantInput, CreditScheduleInput } from '@sandboxes/billing';

/** The Merv↔Sandboxes bridge's people: every verified Merv person has their own Sandboxes account. */
export interface SandboxesPeople {
  /**
   * Idempotent. The verified person's Sandboxes person, their own account with them its admin,
   * and the configured welcome credits, granted once per provider; answers that account. `label`
   * names a person Sandboxes does not know yet. Refusals are Merv errors.
   */
  ensure(person: Person): Promise<{ accountId: string }>;
  /** Their own account and the name Sandboxes knows them by, if it knows them yet. Reads only. */
  accountOf(person: Person): Promise<{ accountId: string; name: string | null } | null>;
  /** Credit on the person's own account (`ensure`d) that they may spend: the grant or schedule,
   *  then the account's access to each operator connection of its provider where no operator
   *  has decided it yet, so an access revoked stays revoked. A disabled schedule grants none. */
  grant(person: Person, input: Omit<CreditGrantInput, 'accountId'>): Promise<void>;
  schedule(person: Person, input: Omit<CreditScheduleInput, 'accountId'>): Promise<void>;
}
type Person = { issuer: string; subject: string; label?: string };

declare module 'cordis' {
  interface Context {
    sandboxesPeople: SandboxesPeople;
  }
}
