import type { z } from 'zod';
import { MervError, quoted } from '@merv/contracts';

/** What every HTTP adapter answers for a path or method it does not serve. */
export const unknownEndpoint = () => new MervError('not_found', 'Unknown endpoint', 404);

/** A parse's data, or 400 invalid_input with each issue's path, message and code. */
export function validated<T>(
  parsed: z.SafeParseReturnType<unknown, T>,
  message = 'Request body failed validation',
): T {
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(({ path, message, code }) => ({ path, message, code }));
  throw new MervError('invalid_input', message, 400, issues);
}

/** The one project every given selection names, if any: 400 when one is blank or two differ. */
export function projectSelection(...selections: unknown[]): string | undefined {
  const supplied = selections.filter((selection) => selection !== undefined);
  for (const selection of supplied)
    if (typeof selection !== 'string' || !selection.trim())
      throw new MervError('invalid_input', 'projectId must be a non-empty string');
  // A model that garbles a long id gets this, so it names both ids rather than reading as a
  // conflict inside the server.
  const other = supplied.find((selection) => selection !== supplied[0]);
  if (other !== undefined)
    throw new MervError(
      'invalid_input',
      `Conflicting Merv project selections: ${[supplied[0], other].map((id) => quoted(id, 100)).join(' and ')}. A request works in one project, and a session, actor token or project key already selects its own: omit projectId, or pass exactly that id`,
    );
  return supplied[0] as string | undefined;
}
