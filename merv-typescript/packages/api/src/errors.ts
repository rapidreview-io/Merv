import { MervError } from '@merv/contracts';

/** What every HTTP adapter answers for a path or method it does not serve. */
export const unknownEndpoint = () => new MervError('not_found', 'Unknown endpoint', 404);
