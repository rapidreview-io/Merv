import type {} from 'cordis';

/** The Merv↔Sandboxes bridge's people: every verified Merv person has their own Sandboxes account. */
export interface SandboxesPeople {
  /**
   * Idempotent. The verified person's Sandboxes person, their own account with them its admin,
   * and the configured welcome credits, granted once per provider; answers that account. `label`
   * names a person Sandboxes does not know yet. Refusals are Merv errors.
   */
  ensure(person: {
    issuer: string;
    subject: string;
    label?: string;
  }): Promise<{ accountId: string }>;
}

declare module 'cordis' {
  interface Context {
    sandboxesPeople: SandboxesPeople;
  }
}
