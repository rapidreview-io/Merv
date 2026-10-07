/**
 * The origins Merv may name for a service outside it, as pure checks with no dependency: a
 * bundle that runs outside Main (Pi's worker) applies the same rule as Main's origin().
 */
import { isIP } from 'node:net';

/** An https origin, or a loopback http one for a test's fake service. */
export function allowedOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== value) return false;
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        (url.hostname === 'localhost' ||
          url.hostname === '[::1]' ||
          (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'))))
    );
  } catch {
    return false;
  }
}

/** An http(s) URL on an allowed origin, naming no credentials, query or fragment; any path. */
export function allowedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      // A blob: URL's origin is the URL inside it, so the scheme is checked on its own.
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      !/[\x00-\x20\x7f?#]/.test(value) &&
      !url.username &&
      !url.password &&
      allowedOrigin(url.origin)
    );
  } catch {
    return false;
  }
}

/** An allowed origin with nothing after it but a slash; origin() refuses anything else. */
export const isOrigin = (value: unknown): value is string =>
  typeof value === 'string' && allowedUrl(value) && new URL(value).pathname === '/';
