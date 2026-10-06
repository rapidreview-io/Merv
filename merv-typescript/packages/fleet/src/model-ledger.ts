/** Model token accounting shared by Fleet's relay, Pi's relay and the sessions that grant them.
 *  Pure rules: no service, so any unit may run them. The two ledgers stay separate tables. */
import { digest, type Sql } from '@merv/contracts';

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
/** A daily token ledger, `table(person,day,tokens)`. `charge` adds a call's most to the day unless
 *  the day's total would pass `ceiling` (false then); `settle` corrects that day by `delta`. */
export const dailyTokens = (table: string) => ({
  charge: async (sql: Sql, person: string, day: string, tokens: number, ceiling: number) =>
    tokens <= ceiling &&
    !!(await sql.get(
      `INSERT INTO ${table}(person,day,tokens) VALUES(?,?,?) ON CONFLICT(person,day) DO UPDATE SET tokens=${table}.tokens+excluded.tokens WHERE ${table}.tokens+excluded.tokens <= ? RETURNING tokens`,
      person,
      day,
      tokens,
      ceiling,
    )),
  settle: (sql: Sql, person: string, day: string, delta: number) =>
    sql.run(`UPDATE ${table} SET tokens=tokens+? WHERE person=? AND day=?`, delta, person, day),
});
