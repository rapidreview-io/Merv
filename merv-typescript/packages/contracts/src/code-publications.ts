import type { Caller } from './index.js';
import type { GitHubPullDetails } from './github-models.js';
import { z } from 'zod';

import type { CodePublication } from './code-publication-models.js';
export type { CodePublication } from './code-publication-models.js';
export const codePublicationIdSchema = z
  .object({ proposalId: z.string().regex(/^codeprop_[A-Za-z0-9_-]+$/) })
  .strict();
export const codePublicationMergeSchema = codePublicationIdSchema
  .extend({
    expectedHead: z.string().regex(/^[0-9a-f]{40}$/),
    expectedBase: z.string().regex(/^[0-9a-f]{40}$/),
    requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),
  })
  .strict();
export type CodePublicationMerge = z.infer<typeof codePublicationMergeSchema>;
export interface CodePublicationApi {
  publications(caller: Caller): Promise<CodePublication[]>;
  syncPublications(caller: Caller): Promise<CodePublication[]>;
  publicationDetails(
    caller: Caller,
    proposalId: string,
  ): Promise<{ publication: CodePublication; details: GitHubPullDetails | null }>;
  mergePublication(caller: Caller, input: CodePublicationMerge): Promise<CodePublication>;
}
