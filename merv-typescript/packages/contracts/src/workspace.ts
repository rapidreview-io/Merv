import { z } from 'zod';

export type { SessionWorkspace, SessionWorkspaceRecord } from './sessions-models.js';

const label = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const count = z.number().int().nonnegative().safe();
const branch = z
  .string()
  .min(1)
  .max(500)
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
    if (!dataRecord(value, fields, ['treeOid']) || !dataRecord(value.stats, stats))
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
        branch: branch.nullable(),
        baseOid: oid,
        headOid: oid,
        treeOid: oid.optional(),
        stats: z
          .object({ commitCount: count, filesChanged: count, insertions: count, deletions: count })
          .strict(),
      })
      .strict()
      .refine(
        (value) =>
          value.baseOid.length === value.headOid.length &&
          (value.treeOid === undefined || value.treeOid.length === value.baseOid.length),
        'Workspace OIDs must use the same Git object format',
      ),
  );
