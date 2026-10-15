import { z } from 'zod';
import { check, MervError } from '@merv/contracts';
import type { ApiRequest } from '@merv/api/types';
import type { CustomerAccess } from './access.js';
import type { FilesService } from './files.js';

const route =
  /^\/customer-experiments\/requests\/(ce_[a-f0-9]{32})\/files(?:\/(uploads|rename|download)(?:\/([A-Za-z0-9._~+=%-]{1,2048})(?:\/(parts|complete))?)?)?$/;
export const isFilesPath = (path: string) => route.test(path);

const key = z.string().min(1).max(4096);
const createSchema = z
  .object({
    key,
    size: z.number().int().min(0),
    contentType: z.string().max(255).optional(),
  })
  .strict();
const partsSchema = z
  .object({ key, partNumbers: z.array(z.number().int().min(1).max(10000)).min(1).max(1000) })
  .strict();
const completeSchema = z
  .object({
    key,
    parts: z
      .array(
        z.object({
          partNumber: z.number().int().min(1).max(10000),
          etag: z.string().min(1).max(200),
        }),
      )
      .min(1)
      .max(10000),
  })
  .strict();
const renameSchema = z.object({ from: key, to: key }).strict();

/** `/files` of a v3 request: the customer manages them, the customer's agent may only read. */
export async function filesHttp(
  access: CustomerAccess,
  files: FilesService | undefined,
  req: { method?: string; headers: Record<string, string | string[] | undefined> },
  r: ApiRequest,
) {
  const [, id, action, encoded, end] = route.exec(r.url.pathname)!;
  // Upload IDs are the store's own; R2's may hold `/`, so the page sends them URI-encoded.
  let child: string | undefined;
  try {
    child = encoded === undefined ? undefined : decodeURIComponent(encoded);
  } catch {
    throw new MervError('not_found', 'Upload not found', 404);
  }
  const method = req.method ?? 'GET',
    query = r.url.searchParams;
  const read =
    (!action && method === 'GET') || (action === 'download' && !child && method === 'GET');
  // The customer is the capability plus the browser bound to the request.
  const { record } = await access.authorize(
    id!,
    r.bearer(),
    req,
    read ? ['agent', 'customer'] : ['customer'],
  );
  check(files?.storage, 'files_unavailable', 'File storage is not configured', 503);
  if (!action && method === 'GET')
    return files.list(record, query.get('prefix') ?? '', query.get('cursor') ?? undefined);
  if (action === 'download' && !child && method === 'GET')
    return files.download(record, query.get('key') ?? '');
  if (!action && method === 'DELETE') {
    const target = query.has('key')
      ? { key: query.get('key')! }
      : { prefix: query.get('prefix') ?? '' };
    return files.remove(record, target);
  }
  if (action === 'rename' && !child && method === 'POST')
    return files.rename(record, await r.json(renameSchema, 16000));
  if (action === 'uploads' && !child && method === 'POST')
    return files.createUpload(record, await r.json(createSchema, 16000));
  if (action === 'uploads' && child && end === 'parts' && method === 'POST')
    return files.parts(record, child, await r.json(partsSchema, 64000));
  if (action === 'uploads' && child && end === 'complete' && method === 'POST')
    return files.complete(record, child, await r.json(completeSchema, 2_000_000));
  if (action === 'uploads' && child && !end && method === 'DELETE')
    return files.abort(record, child, query.get('key') ?? '');
  throw new MervError('not_found', 'Route not found', 404);
}
