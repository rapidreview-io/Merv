import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** Addresses no page reaches: private, loopback, link-local, reserved, and what embeds them. */
const closed = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  closed.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  // NAT64, Teredo and 6to4 carry an IPv4 address inside; IPv4-mapped the list checks itself.
  ['64:ff9b::', 96],
  ['2001::', 32],
  ['2002::', 16],
] as const)
  closed.addSubnet(net, bits, 'ipv6');

export const closedAddress = (ip: string) => {
  const family = isIP(ip);
  return !family || closed.check(ip, family === 4 ? 'ipv4' : 'ipv6');
};

export type Resolve = (host: string) => Promise<string[]>;
const resolved: Resolve = async (host) =>
  (await lookup(host, { all: true })).map(({ address }) => address);

export type Guard = (address: string) => Promise<string | undefined>;

/**
 * Why a page may not reach an address, or nothing. The URL parser does the hard part: it turns
 * decimal, hex and octal hosts into dotted IPv4 and normalizes bracketed IPv6, so only one form
 * reaches the check. Answers per host are kept for a minute, since a page asks hundreds of times.
 */
export function guard(ownHosts: string[], resolve: Resolve = resolved): Guard {
  const known = new Map<string, { at: number; why: Promise<string | undefined> }>();
  const hostRefused = async (host: string) => {
    if (ownHosts.some((own) => host === own || host.endsWith(`.${own}`))) return 'our own host';
    if (isIP(host)) return closedAddress(host) ? 'a private address' : undefined;
    if (/(^|\.)(localhost|local|internal|intranet|home|lan)$/.test(host) || !host.includes('.'))
      return 'a private address';
    const addresses = await resolve(host).catch(() => []);
    if (!addresses.length) return 'a host that does not resolve';
    return addresses.some(closedAddress) ? 'a private address' : undefined;
  };
  return async (address) => {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return 'not a web address';
    }
    // What a page holds in itself crosses no network.
    if (['data:', 'blob:', 'about:'].includes(url.protocol)) return undefined;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'not http or https';
    if (url.username || url.password) return 'an address with credentials in it';
    const host = url.hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
      .toLowerCase();
    let entry = known.get(host);
    if (!entry || Date.now() - entry.at > 60_000) {
      entry = { at: Date.now(), why: hostRefused(host) };
      known.set(host, entry);
      if (known.size > 2000) known.delete(known.keys().next().value!);
    }
    return await entry.why;
  };
}

/** Fields no agent types into, by what the element says it is. */
const SECRET =
  /pass(word|wd|code|phrase)|\bpwd\b|\bpin\b|otp|one.?time|card|\bcc\b|cc-?(num|exp|csc)|cvv|cvc|csc|expir|iban|routing|account.?(num|no)|\bssn\b|social.?security|security.?code/i;
export interface FieldFacts {
  tag: string;
  type: string;
  autocomplete: string;
  words: string;
}
export const secretField = ({ type, autocomplete, words }: FieldFacts) =>
  type === 'password' ||
  /^(cc-|current-password|new-password|one-time-code)/.test(autocomplete) ||
  SECRET.test(words);
/** Runs in the page: what an element says it is; a label stands for the control it clicks. */
export const fieldFacts = (element: Element): FieldFacts => {
  const label = element.closest('label') as HTMLLabelElement | null;
  const field = (label?.control ?? element) as HTMLInputElement;
  return {
    tag: field.tagName.toLowerCase(),
    type: (field.getAttribute('type') ?? '').toLowerCase(),
    autocomplete: (field.getAttribute('autocomplete') ?? '').toLowerCase(),
    words: ['name', 'id', 'placeholder', 'aria-label', 'data-testid']
      .map((name) => field.getAttribute(name) ?? '')
      .concat(label?.textContent ?? '')
      .join(' ')
      .slice(0, 500),
  };
};

/** What the model is given of a page's accessibility snapshot, one line each. */
const KEPT =
  /^- (heading|link|button|textbox|searchbox|combobox|checkbox|radio|switch|tab|menuitem|option|slider|spinbutton|paragraph|text|cell|listitem|img|code|blockquote|caption|term|definition)\b/;
export function pageLines(snapshot: string): string[] {
  return snapshot.split('\n').flatMap((line) => {
    const flat = line
      .trim()
      .replace(/ \[(cursor=pointer|active)\]/g, '')
      .replace(/:$/, '');
    if (!KEPT.test(flat) || flat === '- paragraph' || /^- listitem \[ref=\w+\]$/.test(flat))
      return [];
    if (/^- (cell|img|text|code) *(\[ref=\w+\])?$/.test(flat)) return [];
    return [flat.length > 240 ? `${flat.slice(0, 240)}…` : flat];
  });
}
export const OUTLINE_CHARS = 6000;
export function outlineOf(lines: string[], most = OUTLINE_CHARS) {
  const kept: string[] = [];
  let room = most;
  for (const line of lines) {
    if (line.length + 1 > room) return { outline: kept.join('\n'), cut: true as const };
    room -= line.length + 1;
    kept.push(line);
  }
  return { outline: kept.join('\n') };
}
const CHALLENGE =
  /just a moment|attention required|verify (that )?you('| a)re (a )?human|are you a (human|robot)|checking your browser|unusual traffic|captcha|access denied|(you('|’)ve|you have) been blocked|blocked by network security|request blocked|enable javascript and cookies/i;
/** A page that stands between the agent and the site, whether as a status (often with an empty
 *  page) or in words on a 200: it says so, and solves nothing. */
export const challenged = (title: string, firstWords: string, status = 200) =>
  status === 403 ||
  status === 429 ||
  CHALLENGE.test(title) ||
  CHALLENGE.test(firstWords.slice(0, 600));
