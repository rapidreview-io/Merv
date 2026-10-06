import { z } from 'zod';

/** What every Merv record ID looks like. */
export const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
export const idSchema = z.string().regex(idPattern);
/** A Git object ID: SHA-1, or SHA-256 in a repository that uses it. */
export const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const oidSchema = z.string().regex(oidPattern);
/** Text as compared for sameness: case and runs of whitespace do not count. */
export const folded = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
