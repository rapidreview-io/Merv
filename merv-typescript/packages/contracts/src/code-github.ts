import { z } from 'zod';
import type { Caller } from './index.js';
import type { GitHubRepository, GitHubRepositoryInput, GitHubStatus } from './github-models.js';
export type { GitHubRepository, GitHubRepositoryInput, GitHubStatus } from './github-models.js';

export const githubRevisionSchema = z
  .object({ expectedRevision: z.number().int().nonnegative() })
  .strict();
export const githubRepositoryInputSchema = githubRevisionSchema
  .extend({
    installationId: z.number().int().positive().safe().nullable(),
    repositoryId: z.number().int().positive().safe().nullable(),
  })
  .strict()
  .refine((v) => (v.installationId === null) === (v.repositoryId === null));
/** Code owns the connection; transports never receive its GitHub credentials. */
export interface CodeGitHub {
  status(caller: Caller): Promise<GitHubStatus>;
  begin(
    caller: Caller,
    input: { expectedRevision: number },
  ): Promise<{ url: string; cookie: string }>;
  callback(input: {
    state: string;
    code?: string;
    error?: string;
    cookie: string;
  }): Promise<string>;
  finish(caller: Caller, cookie: string): Promise<GitHubStatus>;
  repositories(caller: Caller): Promise<GitHubRepository[]>;
  link(caller: Caller, input: GitHubRepositoryInput): Promise<GitHubStatus>;
  disconnect(caller: Caller, input: { expectedRevision: number }): Promise<GitHubStatus>;
}
