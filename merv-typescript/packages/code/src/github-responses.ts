import { z } from 'zod';
import { check, type GitHubCommit, type GitHubPullRequest } from '@merv/contracts';

export const githubOid = z.string().regex(/^[0-9a-f]{40}$/);
export const githubId = z.number().int().positive().safe();
export const githubUrl = z
  .string()
  .url()
  .max(4096)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  });
const ref = z.object({ ref: z.string().min(1).max(1024), sha: githubOid });
export const githubPullSchema = z.object({
  id: githubId,
  number: githubId,
  node_id: z.string().min(1).max(200),
  html_url: githubUrl,
  title: z.string().max(1024),
  body: z.string().max(65536).nullable(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  head: ref.extend({ repo: z.object({ id: githubId }).nullable() }),
  base: ref.extend({ repo: z.object({ id: githubId }) }),
  merged: z.boolean().optional(),
  merge_commit_sha: githubOid.nullable(),
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().max(80).optional(),
  updated_at: z.string().datetime(),
});
export const githubCommitSchema = z.object({
  sha: githubOid,
  html_url: githubUrl,
  commit: z.object({
    message: z.string().max(65536),
    tree: z.object({ sha: githubOid }),
  }),
  parents: z.array(z.object({ sha: githubOid })).max(100),
});
export const githubFileSchema = z.object({
  filename: z.string().min(1).max(4096),
  previous_filename: z.string().max(4096).optional(),
  status: z.string().max(80),
  additions: z.number().int().nonnegative().safe(),
  deletions: z.number().int().nonnegative().safe(),
  patch: z.string().max(1_000_000).optional(),
});
export const githubCheckSchema = z.object({
  name: z.string().max(1024),
  status: z.string().max(80),
  conclusion: z.string().max(80).nullable(),
  html_url: githubUrl.nullable(),
});
export const githubReviewSchema = z.object({
  id: githubId,
  user: z.object({ login: z.string().max(100) }).nullable(),
  state: z.string().max(80),
  commit_id: githubOid,
  body: z.string().max(65536),
  submitted_at: z.string().datetime().nullable().optional(),
});
export function githubResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  check(parsed.success, 'github_response', 'GitHub returned an invalid response', 502);
  return parsed.data;
}
export function githubPull(value: unknown): GitHubPullRequest {
  const p = githubResponse(githubPullSchema, value);
  return {
    id: p.id,
    number: p.number,
    nodeId: p.node_id,
    url: p.html_url,
    title: p.title,
    body: p.body ?? '',
    state: p.state,
    draft: p.draft,
    head: { ref: p.head.ref, sha: p.head.sha, repositoryId: p.head.repo?.id ?? null },
    base: { ref: p.base.ref, sha: p.base.sha, repositoryId: p.base.repo.id },
    merged: p.merged ?? false,
    mergeCommitSha: p.merge_commit_sha,
    mergeable: p.mergeable ?? null,
    mergeState: p.mergeable_state ?? 'unknown',
    updatedAt: p.updated_at,
  };
}
export function githubCommit(value: unknown): GitHubCommit {
  const c = githubResponse(githubCommitSchema, value);
  return {
    sha: c.sha,
    tree: c.commit.tree.sha,
    parents: c.parents.map((p) => p.sha),
    message: c.commit.message,
    url: c.html_url,
  };
}
/** Do not let repository/ref input choose a host or escape the fixed REST route. */
export function repositoryPath(fullName: string): string {
  check(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName) &&
      !fullName.split('/').some((p) => p === '.' || p === '..'),
    'invalid_github_repository',
    'Invalid GitHub repository',
  );
  return `/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`;
}
