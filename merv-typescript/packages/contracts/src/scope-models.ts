/** A member's role in a project. */
export type Role = 'operator' | 'producer' | 'reviewer' | 'reader';

/** Scope's people, projects and keys as the browser reads them; kept apart from the index so
 * browser-side models can name them. */
export interface Actor {
  /** Credentialless service owning this actor, when present. */
  serviceOwner?: string;
  id: string;
  projectId: string;
  name: string;
  role: Role;
  active: boolean;
  /** Present only for the persistent actor representing a project member. */
  user?: { issuer: string; subject: string };
  /** Credentialless actor owned by a Sessions thread (or a historical assignment). */
  threadId?: string;
  sessionId?: string;
}
export interface Project {
  id: string;
  name: string;
  createdAt: string;
}
/** A machine bearer owned by a verified user; projectId is its immutable issuance project. */
export interface UserKey {
  id: string;
  owner: { issuer: string; subject: string };
  projectId: string;
  grantScope: 'project' | 'account';
  label: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  previousId: string | null;
}
export interface IssuedUserKey {
  key: UserKey;
  /** Returned once; only its digest is stored. */
  token: string;
}

export type Permission = 'read' | 'write' | 'review' | 'admin';
/**
 * Who a call acts as. At most one authority field may be set. A bare `{ actorId, projectId }`
 * names an independent machine actor or a producing service actor directly: it is trusted
 * in-process authority, carries that actor's full role and checks no credential's liveness, so
 * transports never build one (they attach `credentialId`, `human`, `key`, `session`,
 * `conversation` or `managed`). A member actor still needs its person's `human` or `key`
 * authority, and a worker its session.
 */
export interface Caller {
  actorId: string;
  projectId: string;
  /** Transport-authenticated credential identity; never accepted from tool arguments. */
  credentialId?: string;
  /** Verified human authority attached by the transport, never by tool arguments. */
  human?: {
    issuer: string;
    subject: string;
    expiresAt: string;
    membershipId: string;
  };
  /** User-owned machine authority, distinct from human login and actor credentials. */
  key?: { id: string; membershipId: string };
  /** Server-authenticated leased worker. Invocation ids are minted by Sessions, never tools. */
  session?: {
    id: string;
    /** The thread this visit belongs to, whose actor the worker acts as. */
    threadId?: string;
    invocationId?: string;
  };
  conversation?: { id: string; epoch: number; commandId: string; runtimeId: string };
  /** Server-authenticated supervisor; the binding is rechecked on every control. */
  managed?: {
    allocationId: string;
    epoch: number;
    credentialHash: string;
    boundSessionId?: string;
  };
  /** A project's credential-free service acting for a person, never set by a transport. */
  service?: { vouchedBy: DelegationSource };
}
/** Immutable source of a lease; a shared login's short JWT lifetime is not the user lifetime. */
export type DelegationSource = { actorId: string; projectId: string } & (
  | { kind: 'actor'; credentialId: string; expiresAt: string | null }
  | { kind: 'human'; issuer: string; subject: string; membershipId: string }
  | { kind: 'key'; keyId: string; membershipId: string; expiresAt: string | null }
  /** Valid only while the person who vouched for it may still write in its project. */
  | { kind: 'service'; vouchedBy: DelegationSource }
);
