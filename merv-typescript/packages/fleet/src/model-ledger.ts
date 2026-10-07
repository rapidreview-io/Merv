/** Model token accounting shared by Fleet's relay, Pi's relay and the sessions that grant them.
 *  Pure rules: no service, so any unit may run them. The two ledgers stay separate tables. */
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
/** A daily token ledger, `table(person,day,tokens)`: a tokenLedger keyed by person and day. */
export const dailyTokens = (table: string) => {
  const ledger = tokenLedger(table, ['person', 'day']);
  return {
    charge: (sql: Sql, person: string, day: string, tokens: number, ceiling: number) =>
      ledger.charge(sql, [person, day], tokens, ceiling),
    settle: (sql: Sql, person: string, day: string, delta: number) =>
      ledger.settle(sql, [person, day], delta),
  };
};
