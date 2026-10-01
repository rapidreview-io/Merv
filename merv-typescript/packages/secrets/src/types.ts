import type { HumanPrincipal } from '@merv/contracts';
import type {} from 'cordis';

export interface AccountIdentity {
  issuer: string;
  subject: string;
}
export interface HuggingFaceStatus {
  available: boolean;
  configured: boolean;
  updatedAt: string | null;
}
/** Opaque delivery capability. Sessions owns every liveness and identity check. */
export interface HuggingFaceGrant {
  v: 1;
  sessionId: string;
  runnerId: string;
  allocationId: string;
  epoch: number;
  hostRef: string;
  exp: number;
}
export interface HuggingFaceAccess {
  token: string;
  endpoint: string;
}
export interface Secrets {
  readonly huggingFaceEndpoint: string | null;
  registerHuggingFaceAuthority(
    authorize: (grant: HuggingFaceGrant) => Promise<AccountIdentity | null>,
  ): () => void;
  createHuggingFaceAccess(grant: HuggingFaceGrant): Promise<HuggingFaceAccess | null>;
  resolveHuggingFaceGrant(token: string): Promise<string | null>;
  huggingFaceStatus(principal: HumanPrincipal): Promise<HuggingFaceStatus>;
  saveHuggingFace(principal: HumanPrincipal, token: string): Promise<HuggingFaceStatus>;
  removeHuggingFace(principal: HumanPrincipal): Promise<HuggingFaceStatus>;
  /** Private runtime delivery only. The caller must authorize the immutable delegation owner. */
  resolveHuggingFaceToken(identity: AccountIdentity): Promise<string | null>;
}
declare module 'cordis' {
  interface Context {
    secrets: Secrets;
  }
}
