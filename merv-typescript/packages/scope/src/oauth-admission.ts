import { isIP, SocketAddress } from 'node:net';
import type { IncomingMessage } from 'node:http';

const canonical = (ip: string) => {
  if (isIP(ip) !== 6) return ip;
  const normalized = new SocketAddress({ address: ip, family: 'ipv6' }).address;
  return normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
};
function bucket(ip: string): string {
  ip = canonical(ip);
  if (isIP(ip) !== 6) return ip;
  const [head, tail] = ip.split('::');
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? front
      : [...front, ...Array(8 - front.length - back.length).fill('0'), ...back];
  return (
    groups
      .slice(0, 4)
      .map((n) => parseInt(n, 16).toString(16))
      .join(':') + '::/64'
  );
}
/** Limits are per source address (IPv6 /64), per process. Forwarding is trusted only
 * from explicitly named immediate proxies; use the rightmost forwarded address. */
export class OAuthAdmission {
  private readonly proxies: Set<string>;
  private readonly counters = new Map<string, { since: number; count: number }>();
  private sweepAt = 0;
  constructor(
    trustedProxyIps: readonly string[],
    private readonly clock = Date.now,
    private readonly capacity = 10000,
  ) {
    this.proxies = new Set(trustedProxyIps.map(canonical));
  }
  admit(
    req: Pick<IncomingMessage, 'socket' | 'headers'>,
    kind: 'register' | 'authorize',
  ): number | null {
    const now = this.clock();
    if (now >= this.sweepAt) {
      for (const [key, counter] of this.counters)
        if (now - counter.since >= 60000) this.counters.delete(key);
      this.sweepAt = now + 60000;
    }
    let ip = canonical(req.socket.remoteAddress ?? 'unknown');
    const header = req.headers['x-forwarded-for'];
    const forwarded = (Array.isArray(header) ? header.join(',') : (header ?? ''))
      .split(',')
      .at(-1)!
      .trim();
    if (this.proxies.has(ip) && isIP(forwarded)) ip = canonical(forwarded);
    const key = kind + ':' + bucket(ip);
    let counter = this.counters.get(key);
    if (!counter || now - counter.since >= 60000) {
      if (!counter && this.counters.size >= this.capacity) return 60;
      counter = { since: now, count: 0 };
      this.counters.set(key, counter);
    }
    if (counter.count >= (kind === 'register' ? 10 : 30))
      return Math.max(1, Math.ceil((counter.since + 60000 - now) / 1000));
    counter.count++;
    return null;
  }
}
