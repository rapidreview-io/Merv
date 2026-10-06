import type { Role } from './workflow-models.js';

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
  /** Credentialless actor owned by an agent session (or a historical assignment). */
  agentId?: string;
  sessionId?: string;
}
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  /** Current Scope reads always include these; optional for legacy frozen snapshots. */
  summary?: string;
  contextRevision?: number;
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
