/** Model token accounting shared by Fleet's relay, Pi's relay and the sessions that grant them,
 *  and the per-person limits Fleet and Pi keep. Pure rules: no service, so any unit may run them.
 *  Each ledger and limit stays its owner's own table. */
import { digest, type Sql, type SqlValue } from '@merv/contracts';
import type { PersonUse } from './types.js';

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
 *  people's own daily limits, `limitsTable(person,tokens)`, each replacing the deployment's
 *  (`fallback`). */
export const dailyTokens = (table: string, limitsTable: string) => {
  const ledger = tokenLedger(table, ['person', 'day']);
  const limits = ownLimits(limitsTable, 'tokens');
  /** `person`'s daily limit: their own, else `fallback`. */
  const limit = async (sql: Sql, person: string, fallback: number) =>
    (await limits.of(sql, [person])).get(person) ?? fallback;
  return {
    limit,
    setLimit: limits.set,
    charge: async (sql: Sql, person: string, day: string, tokens: number, fallback: number) =>
      ledger.charge(sql, [person, day], tokens, await limit(sql, person, fallback)),
    settle: (sql: Sql, person: string, day: string, delta: number) =>
      ledger.settle(sql, [person, day], delta),
    /** Each of `persons`' tokens over the UTC days [from, to), and the daily limit that holds. */
    used: async (
      sql: Sql,
      persons: readonly string[],
      from: string,
      to: string,
      fallback: number,
    ): Promise<PersonUse[]> => {
      const rows = await sql.all<{ person: string; tokens: number | string }>(
        `SELECT person,SUM(tokens) AS tokens FROM ${table} WHERE day>=? AND day<? AND person IN (${among(persons)}) GROUP BY person`,
        from,
        to,
        ...persons,
      );
      const used = new Map(rows.map((row) => [row.person, Number(row.tokens)]));
      const own = await limits.of(sql, persons);
      return persons.map((person) => ({
        used: used.get(person) ?? 0,
        limit: own.get(person) ?? fallback,
        own: own.has(person),
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
