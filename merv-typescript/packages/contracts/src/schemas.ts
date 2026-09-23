import { createHash } from 'node:crypto';
import { z } from 'zod';

/** What every Merv record ID looks like. */
export const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
export const idSchema = z.string().regex(idPattern);
/** Hex SHA-256 of text, as UTF-8, or of bytes. */
export const sha256Hex = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
/** Text as compared for sameness: case and runs of whitespace do not count. */
export const folded = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
