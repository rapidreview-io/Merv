import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BlockList, isIP, isIPv6 } from 'node:net';
import { z } from 'zod';
import type { AgentLoginCodeMail, AgentLoginNotice } from '@merv/contracts';
import { escapeHtml } from '@merv/contracts/text';
import { tooMany } from './agent-logins.js';
import { emailHtml, mailSchema, type Mail } from './mail.js';

const count = (fallback: number) => z.number().int().positive().max(1_000_000).default(fallback);
const loopback = (hostname: string) => ['127.0.0.1', '[::1]', 'localhost'].includes(hostname);
/** An address range, as `address/bits`. */
const cidr = z.string().refine((value) => {
  const [address = '', bits = '', extra] = value.split('/');
  const family = isIP(address);
  return (
    family !== 0 &&
    extra === undefined &&
    /^\d{1,3}$/.test(bits) &&
    Number(bits) <= (family === 4 ? 32 : 128)
  );
}, 'Expected an address range such as 172.18.0.1/32');
/** Agent sign-in by an emailed code (`/connect`), in the scope-api adapter's configuration. */
export const agentLoginSchema = mailSchema('Agent sign-in emails')
  .extend({
    // The origin stamped into the page, installer and connector: https, or http on loopback.
    publicOrigin: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          (url.protocol === 'https:' || (url.protocol === 'http:' && loopback(url.hostname))) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === '/'
        );
      }),
    /** The MCP server name each client registers: `merv-staging` on staging. */
    serverName: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/)
      .default('merv'),
    /** Proxies whose X-Forwarded-For is believed. The host's Caddy reaches a published Docker
     *  port from the bridge gateway, so a deployment names that gateway's own address (a /32). */
    trustedProxies: z.array(cidr).max(32).default(['127.0.0.1/32', '::1/128']),
    keyDays: count(90),
    retentionDays: count(30),
    limits: z
      .object({
        emailPer15Minutes: count(3),
        emailPerDay: count(10),
        ipPerHour: count(10),
        globalPerMinute: count(30),
        globalPerDay: count(500),
        triesPerLogin: count(5),
        keysPerPerson: count(10),
        // Per IPv4 address or IPv6 /64, and per IPv4 address or IPv6 /48: no cap on all callers.
        verifyPerIpMinute: count(30),
        verifyPerNetworkMinute: count(120),
        queueConcurrency: count(4),
        queueWaiting: count(100),
      })
      .strict()
      .default({}),
  })
  .strict();
export type AgentLoginConfig = z.input<typeof agentLoginSchema>;

/** What the connector sends, and nothing a mail client could render as a link or reorder: letters,
 *  digits, `_` and `-`, in words a single space apart (the host is one word). */
const label = (max: number, words: boolean) =>
  z
    .string()
    .max(max)
    .regex(words ? /^[\p{L}\p{N}_-]+(?: [\p{L}\p{N}_-]+)*$/u : /^[\p{L}\p{N}_-]+$/u);
const digestText = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const startInput = z
  .object({
    email: z
      .string()
      .trim()
      .max(320)
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
      // As invitations do: the directory keeps addresses in lower case.
      .transform((value) => value.toLowerCase()),
    client: z
      .object({ name: label(40, true), host: label(64, false), installId: z.string().uuid() })
      .strict(),
    verifierHash: digestText,
  })
  .strict();
export const verifyInput = z.object({ code: z.string().max(32), verifier: digestText }).strict();

const source = (name: string) =>
  readFileSync(new URL(`./connect/${name}`, import.meta.url), 'utf8');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const day = (iso: string) => iso.slice(0, 10);

/** The code email: the code, the request words, and what signs in. */
export function codeMail(mail: AgentLoginCodeMail, origin: string): Mail {
  const code = `${mail.code.slice(0, 4)}-${mail.code.slice(4)}`;
  const keys = `${origin}/ui/settings/keys`;
  const warning = `The request words only help you match this email to the sign-in you started. Give this code only to an agent you started yourself, and only if it showed you "${mail.phrase}". Whoever has this code and that sign-in request can act as you in Merv. Merv never asks for this code by email, chat or phone. Didn't start this? Ignore this email: nothing happens without the code.`;
  return {
    to: mail.to,
    subject: `${code} is your Merv agent sign-in code`,
    idempotencyKey: `agent-login/${mail.loginId}`,
    text: `Your Merv agent sign-in code\n\n${code}\n\nRequest: ${mail.phrase}\nSigns in: ${mail.label}\nExpires in 10 minutes.\n\n${warning}\nSigned-in agents are listed, and can be revoked, at ${keys}`,
    html: emailHtml(`<h1 style="margin:0 0 20px;font-size:26px;line-height:1.2;font-weight:600">Your Merv agent sign-in code</h1>
<p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:2px;font-family:Menlo,Consolas,monospace">${code}</p>
<p style="margin:0 0 4px;font-size:14px;line-height:1.5">Request: <strong>${escapeHtml(mail.phrase)}</strong></p>
<p style="margin:0 0 4px;font-size:14px;line-height:1.5">Signs in: ${escapeHtml(mail.label)}</p>
<p style="margin:0 0 24px;font-size:14px;line-height:1.5">Expires in 10 minutes.</p>
<p style="margin:0 0 12px;font-size:12px;line-height:1.7">${escapeHtml(warning)}</p>
<p style="margin:0;font-size:12px;line-height:1.7">Signed-in agents are listed, and can be revoked, at <a href="${escapeHtml(keys)}" style="color:#111111">${escapeHtml(keys)}</a></p>`),
  };
}

/** The notice every new agent key sends to its person. */
export function noticeMail(notice: AgentLoginNotice, origin: string): Mail {
  const keys = `${origin}/ui/settings/keys`;
  const when = `${notice.at.slice(0, 10)} ${notice.at.slice(11, 16)} UTC`;
  const lines = [
    `Agent: ${notice.label} (request "${notice.phrase}")`,
    `When: ${when}`,
    `Key expires: ${day(notice.expiresAt)}. It works in every project with your roles, for every agent on that machine.`,
  ];
  return {
    to: notice.to,
    subject: `New Merv agent sign-in: ${notice.label}`,
    idempotencyKey: `agent-key/${notice.keyId}`,
    text: `An agent signed in to Merv as ${notice.to}.\n\n${lines.join('\n')}\n\nNot you? Revoke it now: ${keys}\nThen secure your email account: the sign-in code was sent there.`,
    html: emailHtml(`<h1 style="margin:0 0 20px;font-size:26px;line-height:1.2;font-weight:600">New Merv agent sign-in</h1>
<p style="margin:0 0 16px;font-size:14px;line-height:1.5;overflow-wrap:anywhere">An agent signed in to Merv as ${escapeHtml(notice.to)}.</p>
${lines.map((line) => `<p style="margin:0 0 4px;font-size:14px;line-height:1.5">${escapeHtml(line)}</p>`).join('\n')}
<table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:24px"><tr><td style="background:#111111"><a href="${escapeHtml(keys)}" style="display:inline-block;padding:14px 20px;border:1px solid #111111;background:#111111;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600">Review agent keys</a></td></tr></table>
<p style="margin:24px 0 0;font-size:12px;line-height:1.7">Not you? Revoke it on the Keys page, then secure your email account: the sign-in code was sent there.</p>`),
  };
}

/** The page, installer and connector `/connect` serves, stamped with this deployment's origin
 *  and server name; the installer carries the connector's digest. */
export function connectAssets(config: z.output<typeof agentLoginSchema>) {
  const origin = new URL(config.publicOrigin).origin;
  const stamp = (text: string) =>
    text
      .replaceAll('__MERV_ORIGIN__', origin)
      .replaceAll('__MERV_HOSTDIR__', new URL(origin).host.replace(':', '_'))
      .replaceAll('__MERV_SERVER_NAME__', config.serverName);
  const raw = source('merv-connect.mjs');
  const connector = stamp(raw).replaceAll('__MERV_VERSION__', sha256(raw).slice(0, 12));
  return {
    origin,
    page: stamp(source('page.txt')),
    installer: stamp(source('install.sh')).replace('__CONNECTOR_SHA256__', sha256(connector)),
    connector,
  };
}

/** The ranges `trustedProxies` names, to check a socket's address against. */
export function proxyList(ranges: readonly string[]): BlockList {
  const list = new BlockList();
  for (const range of ranges) {
    const [address, bits] = range.split('/') as [string, string];
    list.addSubnet(address, Number(bits), isIP(address) === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

/** Background delivery, after the reply: a few jobs at a time and a bounded number waiting. */
export class Deliveries {
  private readonly running = new Set<Promise<void>>();
  private readonly waiting: (() => Promise<void>)[] = [];
  constructor(
    private readonly concurrency: number,
    private readonly capacity: number,
  ) {}
  get full(): boolean {
    return this.running.size + this.waiting.length >= this.concurrency + this.capacity;
  }
  push(job: () => Promise<void>): void {
    this.waiting.push(job);
    this.pump();
  }
  private pump(): void {
    while (this.running.size < this.concurrency && this.waiting.length) {
      const run: Promise<void> = this.waiting.shift()!().finally(() => {
        this.running.delete(run);
        this.pump();
      });
      this.running.add(run);
    }
  }
  /** Waits for every job, those still waiting included. */
  async drain(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }
}

/** Where an address counts: itself for IPv4; for IPv6 its /64, since one subscriber holds a whole
 *  /64 and could otherwise rotate through it, or its /48, the most a site is usually given. */
export function addressBucket(ip: string | null, bits: 48 | 64 = 64): string {
  if (!ip || !isIPv6(ip)) return ip ?? '';
  const groups = (part: string | undefined) =>
    part ? part.split(':').flatMap((group) => (group.includes('.') ? ['0', '0'] : [group])) : [];
  const [head, tail] = ip.split('%')[0]!.split('::');
  const front = groups(head);
  const back = groups(tail);
  const all =
    tail === undefined
      ? front
      : [...front, ...Array(8 - front.length - back.length).fill('0'), ...back];
  return `${all
    .slice(0, bits / 16)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/${bits}`;
}

/**
 * Verify admission in fixed one-minute windows, constant work a request: per address (an IPv4
 * address or IPv6 /64) and per network (an IPv4 address or IPv6 /48), with no cap on all callers,
 * so no network can spend another's attempts. A window holds at most `ceiling` buckets: past it
 * only a new bucket is refused, and a new window drops the tables whole. In process: a restart
 * forgets it, and the per-login tries stay the durable bound.
 */
export class Admission {
  private start = -Infinity;
  private counts = new Map<string, number>();
  constructor(
    private readonly perAddress: number,
    private readonly perNetwork: number,
    private readonly clock: () => number = Date.now,
    private readonly ceiling = 100_000,
  ) {}
  /** The number of buckets this window holds. */
  get size(): number {
    return this.counts.size;
  }
  /** Counts one request from `ip`, or throws 429 past its address's or its network's limit. */
  admit(ip: string | null): void {
    const now = this.clock();
    if (now - this.start >= 60_000) {
      this.start = now;
      this.counts = new Map();
    }
    const buckets = [addressBucket(ip), `${addressBucket(ip, 48)} network`];
    const [address = 0, network = 0] = buckets.map((bucket) => this.counts.get(bucket) ?? 0);
    const fresh = Number(!address) + Number(!network);
    if (
      address >= this.perAddress ||
      network >= this.perNetwork ||
      this.size + fresh > this.ceiling
    )
      throw tooMany(
        'login_rate_limited',
        Math.ceil((this.start + 60_000 - now) / 1000),
        'Too many sign-in attempts; wait a minute and try again',
      );
    this.counts.set(buckets[0]!, address + 1).set(buckets[1]!, network + 1);
  }
}
