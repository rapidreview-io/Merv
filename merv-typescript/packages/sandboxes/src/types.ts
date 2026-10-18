/** What other plugins read of the Merv↔Sandboxes bridge: types alone. */

/** Every verified person's own Sandboxes account (docs/ADMIN.md "Every person has a Sandboxes
 *  account"). */
export interface SandboxesPeople {
  /** The person's own account and their membership of it, made now if missing, with the base
   *  credits it is granted once. */
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
