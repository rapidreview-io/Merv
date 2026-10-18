/** What Customer experiments shows outside itself, for the platform admin alone: a request's
 *  experiment as its customer sees it, without the customer's token, and the customers of named
 *  work. Never a capability or checkout. */
export interface StandaloneExperiments {
  snapshot(requestId: string): Promise<unknown>;
  customers(work: readonly { id: string; state: string }[]): Promise<Map<string, Customer>>;
}
export interface Customer {
  id: string;
  requestId: string;
  issuer: string | null;
  subject: string | null;
  email: string | null;
  /** The customer's move the experiment's state waits on, if any. */
  waits: 'approval' | 'payment' | null;
}
declare module 'cordis' {
  interface Context {
    customerExperiments: StandaloneExperiments;
  }
}
