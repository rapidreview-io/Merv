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
  ip_hash: string | null;
  install_id: string;
  client: string;
  host: string;
  phrase: string;
  verifier_hash: string;
  code_hash: string;
  issuer: string | null;
  subject: string | null;
  created_at: string;
  expires_at: string;
  sent_at: string | null;
  failures: number;
  status: 'pending' | 'used' | 'locked';
  key_id: string | null;
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
const iso = (ms: number) => new Date(ms).toISOString();
/** 429 past a sign-in limit: `login_capacity` for Merv's own caps, else `login_rate_limited`. */
export const tooMany = (code: 'login_capacity' | 'login_rate_limited', seconds: number) =>
  new MervError(
    code,
    code === 'login_capacity'
      ? 'Merv is sending too many sign-in codes right now; try again later'
      : 'Too many sign-in requests; try again later',
    429,
    { retryAfterSeconds: seconds },
  );
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
 * start is counted as a row inside the writer transaction before any directory call or email, so
 * nothing in the background can exceed a cap that was not reserved.
 */
export class AgentLogins implements ScopeAgentLogins {
  constructor(
    private readonly state: State,
    private readonly clock: () => number,
    private readonly members: Memberships,
    private readonly keys: UserKeys,
  ) {}

  /** Refuses a start past any limit, counting every stored request whatever its address. */
  private async admit(
    sql: Sql,
    emailHash: string,
    ipHash: string | null,
    now: number,
    limits: AgentLoginLimits,
  ): Promise<void> {
    const today = now - (now % DAY);
    const counts = await sql.get<Record<string, string | number>>(
      `SELECT
         SUM(CASE WHEN email_hash=? AND created_at>=? THEN 1 ELSE 0 END) AS email_recent,
         SUM(CASE WHEN email_hash=? AND created_at>=? THEN 1 ELSE 0 END) AS email_day,
         SUM(CASE WHEN ip_hash=? AND created_at>=? THEN 1 ELSE 0 END) AS ip_hour,
         SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) AS minute,
         SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) AS day
       FROM agent_logins WHERE created_at>=?`,
      emailHash,
      iso(now - 15 * MINUTE),
      emailHash,
      iso(today),
      ipHash,
      iso(now - 60 * MINUTE),
      iso(now - MINUTE),
      iso(today),
      iso(Math.min(today, now - 60 * MINUTE)),
    );
    const count = (name: string) => Number(counts?.[name] ?? 0);
    const untilTomorrow = Math.ceil((today + DAY - now) / 1000);
    const refusals: [boolean, 'login_capacity' | 'login_rate_limited', number][] = [
      [count('minute') >= limits.globalPerMinute, 'login_capacity', 60],
      [count('day') >= limits.globalPerDay, 'login_capacity', untilTomorrow],
      [count('email_recent') >= limits.emailPer15Minutes, 'login_rate_limited', 15 * 60],
      [count('email_day') >= limits.emailPerDay, 'login_rate_limited', untilTomorrow],
      [count('ip_hour') >= limits.ipPerHour, 'login_rate_limited', 60 * 60],
    ];
    const refused = refusals.find(([over]) => over);
    if (refused) throw tooMany(refused[1], refused[2]);
  }

  async start(request: AgentLoginRequest, limits: AgentLoginLimits): Promise<AgentLoginStarted> {
    const emailHash = emailDigest(request.email);
    const ipHash = request.ip === null ? null : digest(request.ip);
    // Obvious refusals take no writer lock; the transaction counts again before it inserts.
    await this.state.read((sql) => this.admit(sql, emailHash, ipHash, this.clock(), limits));
    const login: AgentLoginStarted = {
      loginId: `login_${randomBytes(16).toString('base64url')}`,
      phrase: `${WORDS[randomInt(WORDS.length)]} ${WORDS[randomInt(WORDS.length)]}`,
      expiresAt: '',
      code: String(randomInt(100_000_000)).padStart(8, '0'),
    };
    await this.state.transaction(async (tx) => {
      const now = this.clock();
      await this.admit(tx, emailHash, ipHash, now, limits);
      // Unsuccessful requests are kept for retentionDays; issuance evidence for good.
      await tx.run(
        `DELETE FROM agent_logins WHERE id IN (SELECT id FROM agent_logins
           WHERE key_id IS NULL AND created_at<? ORDER BY created_at LIMIT 100)`,
        iso(now - limits.retentionDays * DAY),
      );
      login.expiresAt = iso(now + TTL);
      await tx.run(
        `INSERT INTO agent_logins(id,email_hash,ip_hash,install_id,client,host,phrase,
           verifier_hash,code_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        login.loginId,
        emailHash,
        ipHash,
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
      const row = await this.state.transaction((tx) =>
        tx.get<LoginRow>(
          `UPDATE agent_logins SET issuer=?,subject=? WHERE id=? AND status='pending'
             AND issuer IS NULL AND sent_at IS NULL AND expires_at>? RETURNING *`,
          found.issuer,
          found.subject,
          login.loginId,
          iso(this.clock()),
        ),
      );
      if (!row) return;
      stage = 'send';
      await send({
        to: user.email,
        loginId: row.id,
        code: login.code,
        phrase: row.phrase,
        label: `${row.client} on ${row.host}`,
      });
      await this.state.transaction((tx) =>
        tx.run('UPDATE agent_logins SET sent_at=? WHERE id=?', iso(this.clock()), row.id),
      );
    } catch {
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
