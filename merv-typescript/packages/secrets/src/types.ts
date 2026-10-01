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
export interface Secrets {
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
