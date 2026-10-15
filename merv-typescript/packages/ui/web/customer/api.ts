import { ApiError, safely } from '../api';

/**
 * The customer page's requests: every one under /customer-experiments/requests/<id>, with the
 * request's capability (`Authorization: Bearer`) and, once signed in, the person's Supabase
 * access token (`X-Merv-Identity`). Nothing here reads or sends the app's own account token.
 */

const PAGE = /^\/customer-experiments\/r\/(ce_[a-f0-9]{32})\/?$/;

/** The request this page is for: its address, or `?request=` where the page is opened by hand. */
export const requestOf = (where: Pick<Location, 'pathname' | 'search'> = location) =>
  PAGE.exec(where.pathname)?.[1] ?? new URLSearchParams(where.search).get('request') ?? null;

/** Where customer-page.ts keeps a request's capability, so both pages share it in a tab. */
const capabilityKey = (id: string) => `merv:customer-experiment:${id}`;

/**
 * The capability the link carries in its fragment (`#token=` or the bare token), kept for this
 * tab and taken off the address bar so it is never shared, bookmarked or sent as a referrer.
 */
export function takeCapability(id: string): string | null {
  const fragment = location.hash.slice(1);
  let token = '';
  try {
    token = fragment.startsWith('token=')
      ? (new URLSearchParams(fragment).get('token') ?? '')
      : decodeURIComponent(fragment);
  } catch {
    token = '';
  }
  if (token) safely(() => sessionStorage.setItem(capabilityKey(id), token));
  else token = safely(() => sessionStorage.getItem(capabilityKey(id)), null) ?? '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return token || null;
}

export interface Credentials {
  request: string;
  capability: string;
  /** The person's access token now, or null before sign-in. */
  identity(): string | null;
  /** A fresh access token after the server refused one; null where there is none. */
  renew(): Promise<string | null>;
}

let credentials: Credentials | null = null;
export const setCredentials = (value: Credentials | null) => {
  credentials = value;
};
export const currentCredentials = () => credentials;

const lost = new Set<() => void>();
/** Listens for the request being taken over by another browser (`bound_elsewhere`). */
export const onBoundElsewhere = (listener: () => void) => {
  lost.add(listener);
  return () => void lost.delete(listener);
};

export const base = (id: string) => `/customer-experiments/requests/${encodeURIComponent(id)}`;

/** The headers every customer call carries; `identity: false` sends the capability alone. */
export function customerHeaders(identity = true): Record<string, string> {
  const held = credentials;
  if (!held) return {};
  const token = identity ? held.identity() : null;
  return {
    authorization: `Bearer ${held.capability}`,
    ...(token ? { 'x-merv-identity': token } : {}),
  };
}

/**
 * One call to the request's routes (`path` under /customer-experiments/requests/<id>), as JSON.
 * A refused identity is renewed once and the call made again; a refusal is an ApiError in the
 * server's own words.
 */
export async function customerRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; identity?: boolean } = {},
): Promise<T> {
  const held = credentials;
  if (!held) throw new ApiError('unauthorized', 'This link is not valid.', 401);
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${base(held.request)}${path}`, {
        method: options.method ?? 'GET',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...customerHeaders(options.identity ?? true),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      throw new ApiError('offline', 'Merv didn’t answer. Try again.', 0);
    }
    const body = (await response.json().catch(() => null)) as
      (T & { error?: { code: string; message: string } }) | null;
    if (response.status === 401 && attempt === 0 && options.identity !== false) {
      if (await held.renew()) continue;
    }
    if (!response.ok || !body || body.error) {
      const failure = body?.error ?? {
        code: response.ok ? 'invalid_response' : `http_${response.status}`,
        message: response.ok ? 'The server returned an invalid response' : response.statusText,
      };
      if (failure.code === 'bound_elsewhere') for (const listener of lost) listener();
      throw new ApiError(failure.code, failure.message || 'Something went wrong.', response.status);
    }
    return body;
  }
}

/** A refusal in the server's words where it wrote them for a person, otherwise `fallback`. */
export const said = (cause: unknown, fallback: string): string => {
  if (!(cause instanceof ApiError)) return fallback;
  if (cause.status === 0) return 'Merv didn’t answer. Try again.';
  if (cause.status >= 500 || cause.code.startsWith('http_')) return fallback;
  return cause.message || fallback;
};
