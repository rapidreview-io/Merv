import { z } from 'zod';
import type { Caller } from './index.js';
import type {
  GitHubRepository,
  GitHubRepositoryInput,
  GitHubStatus,
  GitHubAutomationInput,
  GitHubBranch,
  GitHubPullRequest,
  GitHubPullDetails,
} from './github-models.js';
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
export const githubBranchSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) &&
      !value.includes('..') &&
      !value.includes('@{') &&
      value !== '@' &&
      !value.startsWith('-') &&
      !value.endsWith('.') &&
      value
        .split('/')
        .every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock')),
  );
export const githubAutomationSchema = githubRevisionSchema
  .extend({
    mode: z.enum(['off', 'read', 'write']),
    baseBranch: githubBranchSchema.nullable(),
  })
  .strict()
  .refine((value) => value.mode === 'off' || value.baseBranch !== null);
/** Code owns the connection; user OAuth credentials never leave the server. */
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
  configureAutomation(caller: Caller, input: GitHubAutomationInput): Promise<GitHubStatus>;
  branches(caller: Caller): Promise<GitHubBranch[]>;
  pulls(caller: Caller): Promise<GitHubPullRequest[]>;
  pullDetails(caller: Caller, number: number): Promise<GitHubPullDetails>;
}
