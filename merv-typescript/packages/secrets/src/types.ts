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
/** A delivery capability until `exp` (Unix seconds). Its binding is opaque to Secrets: the
 *  registered authority that issued it checks liveness and identity. */
export interface HuggingFaceGrant {
  binding: string;
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
}
declare module 'cordis' {
  interface Context {
    secrets: Secrets;
  }
}
