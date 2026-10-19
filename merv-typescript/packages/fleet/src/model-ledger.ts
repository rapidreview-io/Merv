/** Model token accounting shared by Fleet's relay, Pi's relay and the sessions that grant them,
 *  and the per-person limits Fleet and Pi keep. Pure rules: no service, so any unit may run them.
 *  Each ledger and limit stays its owner's own table. */
import { digest, type Sql, type SqlValue } from '@merv/contracts';

/** Whose day a model call counts toward: a person's sign-in identity, else the acting actor.
 *  Every feature keys a person alike, so one day counts all their calls. */
export const personKey = (
  user: { issuer: string; subject: string } | null | undefined,
  actor: { projectId: string; actorId: string },
) =>
  digest(
    user
      ? { issuer: user.issuer, subject: user.subject }
      : { projectId: actor.projectId, actorId: actor.actorId },
  );
/** The provider endpoint model relays call upstream. */
export const RESPONSES_URL = 'https://api.openai.com/v1/responses';
/** A token ledger, `table(...keys,tokens)`. `charge` adds a call's most to the key's total unless
 *  that would pass `ceiling` (false then); `settle` corrects it by `delta`, never below zero. */
export const tokenLedger = (table: string, keys: readonly string[]) => ({
  charge: async (sql: Sql, key: readonly SqlValue[], tokens: number, ceiling: number) =>
    tokens <= ceiling &&
    !!(await sql.get(
      `INSERT INTO ${table}(${keys.join(',')},tokens) VALUES(${keys.map(() => '?').join(',')},?) ON CONFLICT(${keys.join(',')}) DO UPDATE SET tokens=${table}.tokens+excluded.tokens WHERE ${table}.tokens+excluded.tokens <= ? RETURNING tokens`,
      ...key,
      tokens,
      ceiling,
    )),
  settle: (sql: Sql, key: readonly SqlValue[], delta: number) =>
    sql.run(
      `UPDATE ${table} SET tokens=GREATEST(0,tokens+?) WHERE ${keys.map((name) => `${name}=?`).join(' AND ')}`,
      delta,
      ...key,
    ),
});
const among = (persons: readonly string[]) => persons.map(() => '?').join(',') || 'NULL';
/** A daily token ledger, `table(person,day,tokens)`: a tokenLedger keyed by person and day, under
 *  each person's daily limit: the platform admin's for them in `capsTable(person,tokens)`, else the
 *  deployment's (`fallback`), and lower where they set their own in `ownTable(person,tokens)`. */
export const dailyTokens = (table: string, capsTable: string, ownTable?: string) => {
  const ledger = tokenLedger(table, ['person', 'day']);
  const caps = ownLimits(capsTable, 'tokens');
  const own = ownTable ? ownLimits(ownTable, 'tokens') : undefined;
  /** Each of `persons`' cap, whether the admin set it, and the limit that holds under it. */
  const limits = async (sql: Sql, persons: readonly string[], fallback: number) => {
    const [set, lowered] = [
      await caps.of(sql, persons),
      (await own?.of(sql, persons)) ?? new Map(),
    ];
    return persons.map((person) => {
      const cap = set.get(person) ?? fallback;
      return { cap, set: set.has(person), limit: Math.min(lowered.get(person) ?? cap, cap) };
    });
  };
  const limit = async (sql: Sql, person: string, fallback: number) =>
    (await limits(sql, [person], fallback))[0]!;
  return {
    limit,
    setLimit: caps.set,
    setOwn: own?.set,
    charge: async (sql: Sql, person: string, day: string, tokens: number, fallback: number) =>
      ledger.charge(sql, [person, day], tokens, (await limit(sql, person, fallback)).limit),
    settle: (sql: Sql, person: string, day: string, delta: number) =>
      ledger.settle(sql, [person, day], delta),
    /** Each of `persons`' tokens over the UTC days [from, to), the daily limit that holds, and
     *  whether the admin set theirs. */
    used: async (
      sql: Sql,
      persons: readonly string[],
      from: string,
      to: string,
      fallback: number,
    ) => {
      const rows = await sql.all<{ person: string; tokens: number | string }>(
        `SELECT person,SUM(tokens) AS tokens FROM ${table} WHERE day>=? AND day<? AND person IN (${among(persons)}) GROUP BY person`,
        from,
        to,
        ...persons,
      );
      const used = new Map(rows.map((row) => [row.person, Number(row.tokens)]));
      const held = await limits(sql, persons, fallback);
      return persons.map((person, i) => ({
        used: used.get(person) ?? 0,
        limit: held[i]!.limit,
        own: held[i]!.set,
      }));
    },
  };
};
/** People's own daily limits, `table(person,column)`: each replaces the deployment's default. */
export const ownLimits = (table: string, column: string) => ({
  /** Each of `persons`' own limit where they have one, or every one there is. */
  of: async (sql: Sql, persons?: readonly string[]) =>
    new Map(
      (
        await sql.all<{ person: string; value: number | string }>(
          `SELECT person,${column} AS value FROM ${table}${persons ? ` WHERE person IN (${among(persons)})` : ''}`,
          ...(persons ?? []),
        )
      ).map((row) => [row.person, Number(row.value)]),
    ),
  /** Sets `person`'s own limit, or clears it (null) so the default holds again. */
  set: (sql: Sql, person: string, limit: number | null) =>
    limit === null
      ? sql.run(`DELETE FROM ${table} WHERE person=?`, person)
      : sql.run(
          `INSERT INTO ${table}(person,${column}) VALUES(?,?) ON CONFLICT(person) DO UPDATE SET ${column}=excluded.${column}`,
          person,
          limit,
        ),
});
