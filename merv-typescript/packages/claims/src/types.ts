import type { Caller, Transaction } from '@merv/contracts';
import type {} from 'cordis';

export type ClaimStatus =
  'draft' | 'active' | 'supported' | 'weakened' | 'contradicted' | 'abandoned';
export type ClaimConfidence = 'low' | 'medium' | 'high';
export interface Claim {
  id: string;
  projectId: string;
  statement: string;
  scope: string;
  status: ClaimStatus;
  confidence: ClaimConfidence;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface Claims {
  get(caller: Caller, claimId: string, tx?: Transaction): Promise<Claim>;
  /** All statuses in creation-time/ID order, within the current project. */
  list(caller: Caller, tx?: Transaction): Promise<Claim[]>;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    claims: Claims;
  }
}
