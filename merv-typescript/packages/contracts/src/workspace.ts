import { z } from 'zod';
import { idSchema as label, oidSchema as oid } from './schemas.js';

export type { SessionWorkspace, CodePendingMerge } from './sessions-models.js';

const count = z.number().int().nonnegative().safe();
export const gitBranchSchema = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .refine(
      (value) =>
        !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) &&
        !value.startsWith('/') &&
        !value.startsWith('-') &&
        !value.endsWith('/') &&
        !value.endsWith('.') &&
        !value.includes('..') &&
        !value.includes('//') &&
        !value.includes('@{') &&
        value !== '@' &&
        value.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock')),
    );
/** The frozen merge and admitted checkpoint carried by a Code workspace. */
export const codePendingMergeSchema = z
  .object({
    plan: z.string().regex(/^[0-9a-f]{64}$/),
    firstParent: oid,
    secondParent: oid,
    checkpoint: oid,
    firstMerge: oid.nullable(),
  })
  .strict();

const fields = ['repositoryId', 'workspaceId', 'mode', 'branch', 'baseOid', 'headOid', 'stats'];
const stats = ['commitCount', 'filesChanged', 'insertions', 'deletions'];
function dataRecord(
  value: unknown,
  keys: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  const own = Reflect.ownKeys(value);
  if (
    !keys.every((key) => Object.hasOwn(value, key)) ||
    !own.every((key) => typeof key === 'string' && [...keys, ...optional].includes(key))
  )
    return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => Object.hasOwn(descriptor, 'value') && descriptor.enumerable,
  );
}

/** Closed transport/domain schema rejects getters and non-JSON object graphs before traversal. */
export const sessionWorkspaceSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (
      !dataRecord(value, fields, ['treeOid', 'pendingMerge']) ||
      !dataRecord(value.stats, stats) ||
      (value.pendingMerge !== undefined &&
        !dataRecord(value.pendingMerge, [
          'plan',
          'firstParent',
          'secondParent',
          'checkpoint',
          'firstMerge',
        ]))
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Workspace metadata must be a closed plain JSON object',
        fatal: true,
      });
  })
  .pipe(
    z
      .object({
        repositoryId: label,
        workspaceId: label,
        mode: z.enum(['ephemeral', 'persistent']),
        branch: gitBranchSchema(500).nullable(),
        baseOid: oid,
        headOid: oid,
        treeOid: oid.optional(),
        pendingMerge: codePendingMergeSchema.optional(),
        stats: z
          .object({ commitCount: count, filesChanged: count, insertions: count, deletions: count })
          .strict(),
      })
      .strict()
      .refine(
        (value) =>
          value.baseOid.length === value.headOid.length &&
          (value.treeOid === undefined || value.treeOid.length === value.baseOid.length) &&
          (!value.pendingMerge ||
            (value.pendingMerge.checkpoint === value.headOid &&
              [
                value.pendingMerge.firstParent,
                value.pendingMerge.secondParent,
                value.pendingMerge.firstMerge ?? value.baseOid,
              ].every((commit) => commit.length === value.baseOid.length))),
        'Workspace OIDs must use the same Git object format',
      ),
  );
