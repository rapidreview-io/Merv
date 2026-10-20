import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  MervError,
  type AgentLoginCodeMail,
  type AgentLoginDirectory,
  type AgentLoginIssued,
  type AgentLoginLimits,
  type AgentLoginNotice,
  type AgentLoginRequest,
  type AgentLoginStarted,
  type DirectoryUser,
  type ScopeAgentLogins,
  type Sql,
  type State,
} from '@merv/contracts';
import type { Memberships } from './memberships.js';
import type { UserKeys } from './user-keys.js';

/** One stored request for an emailed code. Only digests of the email, address, verifier and code. */
export interface LoginRow {
  id: string;
  email_hash: string;
  install_id: string;
  client: string;
  host: string;
  phrase: string;
  verifier_hash: string;
  code_hash: string;
  issuer: string | null;
  subject: string | null;
  expires_at: string;
  failures: number;
  status: 'pending' | 'used' | 'locked';
}

/** The request words: two of these, which only help a person match an email to a request. */
const WORDS =
  `amber apple arrow aspen autumn badger bamboo basil beacon bear beech berry birch bison
blue bonfire breeze brook bronze cactus camel canyon cardinal cedar cello cherry chestnut cider
citrus clay clover cloud cobalt comet copper coral cotton crane creek crimson crystal cypress daisy
dawn delta desert dolphin dove dune eagle echo elm ember emerald falcon fern fig finch fjord flint
forest fox frost garnet gazelle geyser ginger glacier granite grape harbor hare hazel heron hickory
honey horizon iris island ivory jade jasmine juniper kestrel kiwi koala lagoon lake lantern larch
lark laurel lava lemon lilac lily lime linden lotus lynx magnet maple marble marlin meadow melon
mesa mint mist moon moss nectar nickel nutmeg oak oasis ocean olive onyx orange orbit orchid osprey
otter owl paddle panda pebble pecan pepper pine plum pollen poppy prairie quail quartz quill rabbit
raven reef ridge river robin rose ruby saffron sage salmon sand sapphire seal sequoia shell silver
sky slate sparrow spruce star stone summit sun swan tangerine teal thistle thunder tiger timber
topaz tulip tundra valley velvet violet walnut willow wren yarrow zebra zinc acorn alder anchor
aurora barley bay bell blossom bramble brick candle cascade cinder cliff cobble cocoa cosmos cove
dahlia drift elder fable feather field flame fossil gale garden glade glen grove hawk heath hollow
hyacinth indigo inlet jasper kelp kite lichen lupine mango marsh mason meteor nova oyster pansy
pearl peony petal pilot pond puffin rain reed rowan rye sable shore snow spring stream tamarind
thyme tide trail umber vapor wave wheat whale yew`.split(/\s+/);

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TTL = 10 * MINUTE;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Equal digests, compared in constant time. */
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const verifierDigest = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');
const codeDigest = (id: string, code: string) => digest(`${id}:${code}`);
export const emailDigest = (email: string) => digest(email.trim().toLowerCase());
/** The digests a start is counted by: its email, its address and its network. */
type Hashes = [email: string, ip: string | null, network: string | null];
const iso = (ms: number) => new Date(ms).toISOString();
const untilTomorrow = (now: number) => Math.ceil((DAY - (now % DAY)) / 1000);
/** 429 past a sign-in limit: `login_capacity` for Merv's own caps, else `login_rate_limited`. */
export const tooMany = (
  code: 'login_capacity' | 'login_rate_limited',
  seconds: number,
  message = code === 'login_capacity'
    ? 'Merv is sending too many sign-in codes right now; try again later'
    : 'Too many sign-in requests; try again later',
) => new MervError(code, message, 429, { retryAfterSeconds: seconds });
const invalid = () =>
  new MervError(
    'invalid_code',
    'That code does not match this sign-in. Check it, or run login again.',
    400,
  );

/** Whether the directory vouches for this account as the one the code was requested for. */
const eligible = (user: DirectoryUser | null, emailHash: string): user is DirectoryUser =>
  !!user &&
  !user.anonymous &&
  user.confirmed &&
  !user.banned &&
  !user.deleted &&
  same(emailDigest(user.email), emailHash);

/**
 * Agent sign-in by an emailed code. The stored rows are the only limits and the audit trail: each
 * start is counted as a row against its email, address and network inside the writer transaction, before
 * any directory call or email; the caps in all count only the sends a delivery reserved, by the time
 * it reserved them, checked again in the transaction that reserves, so no flood of other starts can
 * spend them and a held start is counted when it goes out.
 */
export class AgentLogins implements ScopeAgentLogins {
  constructor(
    private readonly state: State,
    private readonly clock: () => number,
    private readonly members: Memberships,
    private readonly keys: UserKeys,
  ) {}

  /** Refuses a start past a limit on its email, address or network, or once the caps in all are spent.
   *  Each count reads an index range no longer than its own limit. */
  private async admit(
    sql: Sql,
    [emailHash, ipHash, netHash]: Hashes,
    now: number,
    limits: AgentLoginLimits,
  ): Promise<void> {
    const since = (column: string) =>
      `(SELECT COUNT(*) FROM agent_logins WHERE ${column}=? AND created_at>=?)`;
    const hour = iso(now - 60 * MINUTE);
    const counts = await sql.get<Record<string, string | number>>(
      `SELECT ${since('email_hash')} AS email_recent, ${since('email_hash')} AS email_day,
         ${since('ip_hash')} AS ip_hour, ${since('net_hash')} AS net_hour`,
      emailHash,
      iso(now - 15 * MINUTE),
      emailHash,
      iso(now - (now % DAY)),
      ipHash,
      hour,
      netHash,
      hour,
    );
    const count = (name: string) => Number(counts?.[name] ?? 0);
    const refusals: [boolean, number][] = [
      [count('email_recent') >= limits.emailPer15Minutes, 15 * 60],
      [count('email_day') >= limits.emailPerDay, untilTomorrow(now)],
      [count('ip_hour') >= limits.ipPerHour, 60 * 60],
      [count('net_hour') >= limits.networkPerHour, 60 * 60],
    ];
    const refused = refusals.find(([over]) => over);
    if (refused) throw tooMany('login_rate_limited', refused[1]);
    await this.capacity(sql, now, limits);
  }

  /** Refuses past the caps in all on codes sent: only sends reserved and not failed count, by when
   *  they were reserved, and a partial index holds those alone. */
  private async capacity(sql: Sql, now: number, limits: AgentLoginLimits): Promise<void> {
    const today = now - (now % DAY);
    const sent = await sql.get<Record<string, string | number>>(
      `SELECT SUM(CASE WHEN sent_at>=? THEN 1 ELSE 0 END) AS minute,
         SUM(CASE WHEN sent_at>=? THEN 1 ELSE 0 END) AS day
       FROM agent_logins WHERE sent_at IS NOT NULL AND sent_at>=?`,
      iso(now - MINUTE),
      iso(today),
      iso(Math.min(today, now - MINUTE)),
    );
    if (Number(sent?.minute ?? 0) >= limits.globalPerMinute) throw tooMany('login_capacity', 60);
    if (Number(sent?.day ?? 0) >= limits.globalPerDay)
      throw tooMany('login_capacity', untilTomorrow(now));
  }

  async start(request: AgentLoginRequest, limits: AgentLoginLimits): Promise<AgentLoginStarted> {
    const hashes: Hashes = [
      emailDigest(request.email),
      request.ip === null ? null : digest(request.ip),
      request.network === null ? null : digest(request.network),
    ];
    // Obvious refusals take no writer lock; the transaction counts again before it inserts.
    await this.state.read((sql) => this.admit(sql, hashes, this.clock(), limits));
    const login: AgentLoginStarted = {
      loginId: `login_${randomBytes(16).toString('base64url')}`,
      phrase: `${WORDS[randomInt(WORDS.length)]} ${WORDS[randomInt(WORDS.length)]}`,
      expiresAt: '',
      code: String(randomInt(100_000_000)).padStart(8, '0'),
    };
    await this.state.transaction(async (tx) => {
      const now = this.clock();
      await this.admit(tx, hashes, now, limits);
      // Unsuccessful requests are kept for retentionDays; issuance evidence for good.
      await tx.run(
        `DELETE FROM agent_logins WHERE id IN (SELECT id FROM agent_logins
           WHERE key_id IS NULL AND created_at<? ORDER BY created_at LIMIT 100)`,
        iso(now - limits.retentionDays * DAY),
      );
      login.expiresAt = iso(now + TTL);
      await tx.run(
        `INSERT INTO agent_logins(id,email_hash,ip_hash,net_hash,install_id,client,host,phrase,
           verifier_hash,code_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        login.loginId,
        ...hashes,
        request.client.installId,
        request.client.name,
        request.client.host,
        login.phrase,
        request.verifierHash,
        codeDigest(login.loginId, login.code),
        iso(now),
        login.expiresAt,
      );
    });
    return login;
  }

  async deliver(
    login: AgentLoginStarted,
    email: string,
    limits: AgentLoginLimits,
    directory: AgentLoginDirectory,
    send: (mail: AgentLoginCodeMail) => Promise<void>,
  ): Promise<void> {
    let stage = 'lookup';
    try {
      const found = await directory.find(email);
      if (!found) return;
      // Only someone who has signed in to Merv and is in a project: a key needs one to anchor it.
      stage = 'membership';
      const member = await this.state.read(
        async (sql) =>
          !!(await sql.get(
            'SELECT 1 FROM shared_users WHERE issuer=? AND subject=?',
            found.issuer,
            found.subject,
          )) &&
          (await this.members.memberProjects(sql, found.issuer, found.subject, null)).length > 0,
      );
      if (!member) return;
      stage = 'directory';
      const user = await directory.user(found.subject);
      if (!eligible(user, emailDigest(email))) return;
      stage = 'reserve';
      // Reserving counts against the caps in all from now; past them nothing is sent.
      const row = await this.state.transaction(async (tx) => {
        const now = this.clock();
        await this.capacity(tx, now, limits);
        return tx.get<LoginRow>(
          `UPDATE agent_logins SET issuer=?,subject=?,sent_at=? WHERE id=? AND status='pending'
             AND issuer IS NULL AND sent_at IS NULL AND expires_at>? RETURNING *`,
          found.issuer,
          found.subject,
          iso(now),
          login.loginId,
          iso(now),
        );
      });
      if (!row) return;
      stage = 'send';
      await send({
        to: user.email,
        loginId: row.id,
        code: login.code,
        phrase: row.phrase,
        label: `${row.client} on ${row.host}`,
      });
    } catch {
      // A send that failed no longer counts against the caps, and its login can never sign in.
      if (stage === 'send')
        await this.state
          .transaction((tx) =>
            tx.run(
              "UPDATE agent_logins SET sent_at=NULL,status='locked' WHERE id=? AND status='pending'",
              login.loginId,
            ),
          )
          .catch(() => undefined);
      // The sign-in id and stage only: never the email, the code or an upstream message.
      process.stderr.write(
        `${JSON.stringify({ event: 'agent_login_undelivered', loginId: login.loginId, stage })}\n`,
      );
    }
  }

  /** A wrong try against a login: counted, and at the limit (or when `lock`) that login locks. */
  private async fail(id: string, limits: AgentLoginLimits, lock = false): Promise<void> {
    await this.state.transaction((tx) =>
      tx.run(
        `UPDATE agent_logins SET failures=failures+1,
           status=CASE WHEN failures+1>=? THEN 'locked' ELSE status END
         WHERE id=? AND status='pending'`,
        lock ? 0 : limits.triesPerLogin,
        id,
      ),
    );
  }

  async verify(
    loginId: string,
    { code, verifier }: { code: string; verifier: string },
    limits: AgentLoginLimits,
    directory: AgentLoginDirectory,
    notify: (notice: AgentLoginNotice) => Promise<void>,
  ): Promise<AgentLoginIssued> {
    // An id this store could not have made costs no read.
    if (!/^login_[A-Za-z0-9_-]{22}$/.test(loginId)) throw invalid();
    const read = (sql: Sql) => sql.get<LoginRow>('SELECT * FROM agent_logins WHERE id=?', loginId);
    // Only the connector that started a login gets past here, so other traffic never writes.
    const row = await this.state.read(read);
    const live = (login: LoginRow | undefined): login is LoginRow =>
      !!login &&
      same(verifierDigest(verifier), login.verifier_hash) &&
      login.status === 'pending' &&
      login.failures < limits.triesPerLogin &&
      login.expires_at > iso(this.clock());
    if (!live(row)) throw invalid();
    const matches = (login: LoginRow) => same(codeDigest(loginId, code), login.code_hash);
    if (!matches(row) || row.issuer === null || row.subject === null) {
      await this.fail(loginId, limits);
      throw invalid();
    }
    // Revalidated now, outside any transaction: an unreachable directory consumes nothing.
    const user = await directory.user(row.subject);
    if (!eligible(user, row.email_hash)) {
      await this.fail(loginId, limits, true);
      throw invalid();
    }
    const { issued, projects } = await this.state.transaction(async (tx) => {
      const current = await read(tx);
      if (
        !live(current) ||
        !matches(current) ||
        current.issuer !== row.issuer ||
        current.subject !== row.subject
      )
        throw invalid();
      const issued = await this.keys.issueForEmailLogin(
        tx,
        { ...current, issuer: row.issuer!, subject: row.subject! },
        limits,
      );
      await tx.run(
        "UPDATE agent_logins SET status='used',key_id=? WHERE id=? AND status='pending'",
        issued.key.id,
        loginId,
      );
      return {
        issued,
        projects: await this.members.memberProjects(tx, row.issuer!, row.subject!, null),
      };
    });
    const label = issued.key.label!;
    const expiresAt = issued.key.expiresAt!;
    try {
      await notify({
        to: user.email,
        keyId: issued.key.id,
        label,
        phrase: row.phrase,
        at: issued.key.createdAt,
        expiresAt,
      });
    } catch {
      // Every key that reaches a connector has had its notice sent.
      await this.keys.revokeIssued(issued.key.id);
      throw new MervError(
        'notice_failed',
        'Merv could not send the sign-in notice; run login again',
        503,
      );
    }
    return {
      token: issued.token,
      key: { id: issued.key.id, label, expiresAt },
      email: user.email,
      projects,
    };
  }
}
