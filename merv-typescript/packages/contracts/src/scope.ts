/** Scope's contract: people, memberships, keys, actor credentials and the authority checks. */
import type {
  ConversationAuthority,
  ManagedRunnerAuthority,
  SessionAuthority,
  Transaction,
} from './index.js';
import type {
  Actor,
  Caller,
  DelegationSource,
  IssuedUserKey,
  Permission,
  Project,
  Role,
  UserKey,
} from './scope-models.js';
import type { ToolPolicy } from './tool-policy.js';
/** Project-bound actor credentials are distinct from human login and future worker leases. */
export interface ActorCredential {
  id: string;
  actorId: string;
  projectId: string;
  kind: 'actor';
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  previousId: string | null;
}
export interface AuthenticatedActor extends Actor {
  credential: ActorCredential;
}
export interface IssuedActorCredential {
  actor: Actor;
  credential: ActorCredential;
  /** Returned once; only its digest is stored. */
  token: string;
}
export interface Credentials extends IssuedActorCredential {
  project: Project;
}
/** Verified by an identity provider outside any State transaction. */
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  expiresAt: string;
}
export interface SharedUser {
  issuer: string;
  subject: string;
  createdAt: string;
}
export interface HumanPrincipal {
  kind: 'user';
  user: SharedUser;
  expiresAt: string;
}
export type Principal =
  HumanPrincipal | { kind: 'actor'; actor: AuthenticatedActor } | { kind: 'key'; key: UserKey };
export interface ProjectMembership {
  id: string;
  projectId: string;
  issuer: string;
  subject: string;
  actorId: string;
  role: Role;
  active: boolean;
  createdAt: string;
  revokedAt: string | null;
}
/** Scope's people: verified identities, the projects they create and their memberships. */
export interface ScopeMembers {
  /** Trusted provider output only; accepting an invitation does not verify an identity. */
  acceptVerifiedIdentity(identity: VerifiedIdentity): Promise<HumanPrincipal>;
  createProject(principal: Principal, input: { name: string; requestId: string }): Promise<Project>;
  memberships(principal: Principal, projectId: string): Promise<ProjectMembership[]>;
  /** Membership administration names subjects of the operator's own identity issuer only. */
  addMember(
    principal: Principal,
    projectId: string,
    input: { subject: string; role: Role },
  ): Promise<ProjectMembership>;
  /** A role change ends the membership and starts a new one. Every delegation source and resolved
   * caller naming the old membership, a worker's lease source included, stops working with it. */
  changeMemberRole(
    principal: Principal,
    projectId: string,
    input: { subject: string; role: Role },
  ): Promise<ProjectMembership>;
  removeMember(principal: Principal, projectId: string, subject: string): Promise<void>;
  /** Host-authority break-glass for the local CLI only, deliberately absent from HTTP/MCP. It
   * makes a verified person the operator of a project with no membership history; with a
   * `repairReason` it restores their operator membership whatever the project's members say,
   * and records why. */
  adoptProject(
    principal: HumanPrincipal,
    projectId: string,
    options?: { repairReason: string },
  ): Promise<ProjectMembership>;
}
/** Keys a person issues to their own machines, which act through the person's memberships. */
export interface ScopeUserKeys {
  authenticate(token: string): Promise<UserKey>;
  /** Verified owners can inspect/revoke their own keys even after losing project membership. */
  keys(principal: Principal, projectId?: string): Promise<UserKey[]>;
  create(
    principal: Principal,
    input: {
      projectId: string;
      grantScope?: 'project' | 'account';
      label?: string | null;
      expiresAt?: string | null;
    },
  ): Promise<IssuedUserKey>;
  /** Rotation preserves owner/grant/project; it requires a current membership within that grant. */
  rotate(
    principal: Principal,
    input: { keyId: string; expiresAt?: string | null },
  ): Promise<IssuedUserKey>;
  /** Revoke the selected key and all of its rotation descendants atomically. */
  revoke(principal: Principal, keyId: string): Promise<void>;
}
/** Independent machine actors and their credentials, and the bootstrap of a first project. */
export interface ScopeActorCredentials {
  bootstrap(input: { projectName: string; actorName: string }): Promise<Credentials>;
  issueActor(
    caller: Caller,
    input: { name: string; role: Role; expiresAt?: string | null },
  ): Promise<IssuedActorCredential>;
  actorCredentials(caller: Caller, actorId?: string): Promise<ActorCredential[]>;
  issueActorCredential(
    caller: Caller,
    input: { actorId: string; expiresAt?: string | null },
  ): Promise<IssuedActorCredential>;
  rotateCredential(
    caller: Caller,
    input: { credentialId: string; expiresAt?: string | null },
  ): Promise<IssuedActorCredential>;
  revokeCredential(caller: Caller, credentialId: string): Promise<void>;
  revokeActor(caller: Caller, actorId: string): Promise<void>;
}
export interface Scope {
  readonly members: ScopeMembers;
  readonly userKeys: ScopeUserKeys;
  readonly credentials: ScopeActorCredentials;
  /** Each project's owner: its longest-standing signed-in operator, as a person, who directs
   * and pays for its work on Fleet's machines. A project with none is left out. */
  projectOwners(tx?: Transaction): Promise<{ projectId: string; source: DelegationSource }[]>;
  /** The person who created the project by signing in; for a bootstrapped or imported one, its
   * owner (see projectOwners); null while it has neither. */
  projectCreator(
    projectId: string,
    tx?: Transaction,
  ): Promise<{ issuer: string; subject: string } | null>;
  /** A credential-free service actor owned by a server provider, scoped to one project. `provider`
   * is a lowercase slug; `role` defaults to producer, and scope@9's trigger refuses a role the
   * provider may not hold. */
  serviceActor(
    provider: string,
    projectId: string,
    tx?: Transaction,
    role?: 'producer' | 'reviewer',
  ): Promise<Caller>;
  readonly toolPolicy: ToolPolicy;
  delegationSource(caller: Caller, tx?: Transaction): Promise<DelegationSource>;
  requireDelegation(
    source: DelegationSource,
    permission: Permission,
    tx?: Transaction,
  ): Promise<Actor>;
  registerSessionAuthority(authority: SessionAuthority): () => void;
  registerConversationAuthority(authority: ConversationAuthority): () => void;
  registerManagedRunnerAuthority(authority: ManagedRunnerAuthority): () => void;
  /** The actor of a Sessions thread, which every visit of the thread acts as. */
  createSessionActor(
    source: DelegationSource,
    input: { threadId: string; role: Exclude<Role, 'operator'>; name: string },
    tx: Transaction,
  ): Promise<Actor>;
  /** Changes a thread's actor's role within what `source` may delegate. Scope does not know who
   * owns a thread: the caller must already have proven it controls this one (Sessions: the thread
   * an offer opens, or resumes for the same source). */
  setThreadRole(
    source: DelegationSource,
    actorId: string,
    role: Exclude<Role, 'operator'>,
    tx: Transaction,
  ): Promise<void>;
  retireSessionActor(actorId: string, reason: string, tx: Transaction): Promise<void>;
  /**
   * Whether this actor was revoked, or lost `permission` through a role change, after event
   * `after`: a restored membership authorizes new work, never what was taken before the loss.
   */
  permissionLost(
    projectId: string,
    actorId: string,
    permission: Permission,
    after: number,
    tx: Transaction,
  ): Promise<boolean>;
  /** Verified delegation owner for scoped remote grants; does not change request attribution. */
  authorityActor(caller: Caller, tx?: Transaction): Promise<Actor>;
  authenticate(token: string): Promise<AuthenticatedActor>;
  /** Recognize any issued local digest, including revoked/expired credentials. */
  recognizesCredential(token: string): Promise<boolean>;
  caller(principal: Principal, projectId?: string): Promise<Caller>;
  projects(principal: Principal): Promise<Project[]>;
  require(caller: Caller, permission: Permission, tx?: Transaction): Promise<Actor>;
  /** Whether this actor may act with `permission`; with `{ except }`, whether any actor but
   * those, and no worker session's, may. */
  eligible(
    projectId: string,
    actor: string | { except: readonly string[] },
    permission: Permission,
    tx?: Transaction,
  ): Promise<boolean>;
  project(caller: Caller, tx?: Transaction): Promise<Project>;
  actors(caller: Caller): Promise<Actor[]>;
}
