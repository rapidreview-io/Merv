import { check, type VerifiedIdentity } from '@merv/contracts';
import { plansDocument } from './program.js';
import type { IdentityBinding, RequestRecord, RequestStore } from './store.js';

/** What customer access reads of the identity plugin (IdentityProvider satisfies it). */
export interface CustomerIdentityProvider {
  verify(token: string, options?: { allowAnonymous?: boolean }): Promise<VerifiedIdentity>;
  configuration(): { enabled: boolean; login?: { url: string; publishableKey: string } };
}
type Headers = { headers: Record<string, string | string[] | undefined> };
export type CustomerGrant =
  | { record: RequestRecord; role: 'agent' }
  /** `identity` is null on structured-intake requests, where the capability alone acts. */
  | { record: RequestRecord; role: 'customer'; identity: IdentityBinding | null };

/**
 * Who a call to a request acts as. The agent capability acts alone, as it always has. For
 * document-plan requests the customer capability (the link's fragment) only acts as the customer
 * together with the browser bound to the request: its Supabase session, usually an anonymous
 * user the page signs in silently, sent as `X-Merv-Identity`. No email is collected.
 */
export class CustomerAccess {
  /** The identity plugin, while one is installed. */
  identity?: CustomerIdentityProvider;
  /** Told of every acting v3 customer call; keeps an unpaid request from looking abandoned. */
  activity?: (requestId: string) => Promise<void>;
  constructor(
    private readonly owner: {
      readonly store: RequestStore;
      version(record: RequestRecord): Promise<number>;
    },
  ) {}
  private login() {
    const login = this.identity?.configuration().login;
    check(login, 'identity_unavailable', 'Customer sign-in is not configured', 503);
    return { provider: this.identity!, login };
  }
  private async verified(req: Headers): Promise<VerifiedIdentity> {
    const { provider } = this.login();
    const token = req.headers['x-merv-identity'];
    check(
      typeof token === 'string' && token,
      'identity_required',
      'Open the experiment page to act as the customer',
      401,
    );
    return provider.verify(token, { allowAnonymous: true });
  }
  async authorize(
    id: string,
    bearer: string,
    req: Headers,
    roles: ('agent' | 'customer')[],
  ): Promise<CustomerGrant> {
    const { record, role } = await this.owner.store.authorizeRole(id, bearer, roles);
    if (role === 'agent') return { record, role };
    if (!plansDocument(await this.owner.version(record))) return { record, role, identity: null };
    const identity = await this.verified(req);
    const bound = await this.owner.store.binding(record.id);
    check(bound, 'identity_unbound', 'Open the experiment page first', 403);
    check(
      bound.issuer === identity.issuer && bound.subject === identity.subject,
      'bound_elsewhere',
      'This experiment is open in another browser',
      409,
    );
    await this.activity?.(record.id);
    return { record, role, identity: bound };
  }
  /** The customer role alone: the capability plus its bound browser for document-plan requests. */
  async requireCustomer(id: string, bearer: string, req: Headers) {
    return (await this.authorize(id, bearer, req, ['customer'])) as Extract<
      CustomerGrant,
      { role: 'customer' }
    >;
  }
  /** GET /session: what the page needs before signing in, read with the capability alone. */
  async session(id: string, bearer: string) {
    const record = await this.owner.store.authorize(id, bearer, ['customer']);
    const { login } = this.login();
    return {
      version: await this.owner.version(record),
      bound: !!(await this.owner.store.binding(record.id)),
      login: { url: login.url, publishableKey: login.publishableKey },
    };
  }
  /** POST /session: the first browser binds the request. Another browser is refused with
   *  `bound_elsewhere` until it asks to take over, which moves the customer role to it. */
  async bind(id: string, bearer: string, req: Headers, takeOver = false) {
    const record = await this.owner.store.authorize(id, bearer, ['customer']);
    check(plansDocument(await this.owner.version(record)), 'not_found', 'Route not found', 404);
    const identity = await this.verified(req);
    const bound = await this.owner.store.bind(record.id, identity, takeOver);
    check(
      bound.issuer === identity.issuer && bound.subject === identity.subject,
      'bound_elsewhere',
      'This experiment is open in another browser',
      409,
    );
    await this.activity?.(record.id);
    return { bound: true };
  }
}
