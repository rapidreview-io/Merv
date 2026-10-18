/** What Customer experiments shows outside itself: a request's experiment as its customer sees
 *  it, without the customer's token, for the platform admin. Never a capability or checkout. */
export interface StandaloneExperiments {
  snapshot(requestId: string): Promise<unknown>;
}
declare module 'cordis' {
  interface Context {
    customerExperiments: StandaloneExperiments;
  }
}
