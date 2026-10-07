/** What a model relay lets a worker's Responses request ask of the provider: one rule for Pi's
 *  relay and hosted Codex's. Pure rules: no service, so any unit may run them. */
import { z } from 'zod';

export const toolChoice = z.enum(['auto', 'none', 'required']);
export const reasoningSummary = z.enum(['auto', 'concise', 'detailed']);

const address = /\b(?:https?:\/\/|data:|file:|ftp:\/\/)/i;
const localRef = /^#\/(?:\$defs|definitions)\/[a-zA-Z0-9_/-]+$/;
/** The dialect a schema names, which nothing fetches: every MCP tool's schema carries one. */
const dialect = /^https?:\/\/json-schema\.org\/[a-z0-9/-]+#?$/;
/** Schema keywords that name or carry content outside the schema. */
const fetchingKeywords = new Set(['contentMediaType', 'contentEncoding', 'url', 'uri']);

/**
 * Whether a request would have the provider fetch or look up content of its own. Anywhere in it:
 * a file by id or URL, a remote image, a stored item, or a schema reference outside its own
 * definitions. In a schema it carries (a tool's `parameters`, an output format's `schema`): any
 * URL or data string but its dialect, and the keywords that name content. A key directly under
 * `properties` names an input field (paper.cite's `url`), not a keyword. Too deep a request
 * counts as fetching.
 */
export function fetchesContent(body: unknown): boolean {
  const walk = (value: unknown, depth: number, schema: boolean, names: boolean): boolean => {
    if (depth > 32) return true;
    if (typeof value === 'string') return schema && address.test(value);
    if (Array.isArray(value)) return value.some((entry) => walk(entry, depth + 1, schema, false));
    if (value === null || typeof value !== 'object') return false;
    return Object.entries(value).some(
      ([key, entry]) =>
        (!names &&
          (key === 'file_id' ||
            key === 'file_url' ||
            (key === 'image_url' && !(typeof entry === 'string' && entry.startsWith('data:'))) ||
            (key === 'type' && (entry === 'input_file' || entry === 'item_reference')) ||
            (key === '$ref' && !(typeof entry === 'string' && localRef.test(entry))) ||
            key === '$dynamicRef' ||
            (schema && fetchingKeywords.has(key)))) ||
        (schema && !names && key === '$schema'
          ? !(typeof entry === 'string' && dialect.test(entry))
          : walk(
              entry,
              depth + 1,
              schema || (!names && (key === 'parameters' || key === 'schema')),
              schema && !names && key === 'properties',
            )),
    );
  };
  return walk(body, 0, false, false);
}
