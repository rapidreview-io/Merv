import { Fragment, useState, type FormEvent, type ReactNode } from 'react';
import { accountRequest, useTool } from '../api';
import { ConfirmAction, Failure, SearchField, Submit, cx, stamp, words } from '../components';
import { Narrowing, matches } from '../list-filters';
import { useCommand } from '../mutations';
import { Lede, Loading, None, Of, Refresh, Tone, count, usd } from './parts';
import type { AdminCredits, CreditAccount } from './types';

/** Whoever holds credit: a person and the accounts they belong to, or an account nobody does. */
interface Holder {
  key: string;
  label: string;
  accounts: { account: CreditAccount; role?: string }[];
  fleet: AdminCredits['people'][number]['fleet'];
  pi: AdminCredits['people'][number]['pi'];
}
function holders(data: AdminCredits): Holder[] {
  const byId = new Map(data.accounts.map((account) => [account.accountId, account]));
  const held = new Set(data.people.flatMap((p) => p.accounts.map((a) => a.accountId)));
  return [
    ...data.people.map((p) => ({
      key: `${p.issuer}|${p.subject}`,
      label: p.label,
      accounts: p.accounts.flatMap(({ accountId, role }) =>
        byId.has(accountId) ? [{ account: byId.get(accountId)!, role }] : [],
      ),
      fleet: p.fleet,
      pi: p.pi,
    })),
    ...data.accounts
      .filter((account) => !held.has(account.accountId))
      .map((account) => ({
        key: account.accountId,
        label: account.name,
        accounts: [{ account }],
        fleet: null,
        pi: null,
      })),
  ];
}
/** What a holder's accounts hold of one provider, summed. */
const pooled = (holder: Holder, provider: string) => {
  const pools = holder.accounts.flatMap(({ account }) =>
    account.pools.filter((pool) => pool.provider === provider),
  );
  const sum = (key: 'granted' | 'available') => pools.reduce((n, pool) => n + Number(pool[key]), 0);
  return pools.length ? { left: sum('available'), granted: sum('granted') } : null;
};

/** A day, with its minute in the hover title. */
const Day = ({ at }: { at: string | null }) => {
  if (!at) return <None />;
  const on = new Date(at);
  const year = on.getFullYear() === new Date().getFullYear() ? undefined : 'numeric';
  return (
    <time dateTime={at} title={stamp(at)}>
      {on.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year })}
    </time>
  );
};

/** The columns of a holding's tables that are words; every other after the first is a figure. */
const WORDS = new Set(['Reason', 'State', '']);
/** A table inside a holding, its first column naming each row. */
function Inner({ name, head, children }: { name: string; head: string[]; children: ReactNode }) {
  return (
    <table className="admin-table admin-table--inner" aria-label={name}>
      <thead>
        <tr>
          {head.map((label, at) => (
            <th key={label + at} className={at && !WORDS.has(label) ? 'num' : undefined}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/** One POST to an /admin route, behind the guard that names it; done, the page is read again. */
function Guarded({
  title,
  confirm,
  path,
  body,
  danger,
  children,
  close,
  done,
}: {
  title: string;
  confirm: string;
  path: string;
  body: Record<string, unknown>;
  danger?: boolean;
  children: ReactNode;
  close(): void;
  done(): void;
}) {
  const command = useCommand<unknown>({
    tool: path,
    idempotent: true,
    send: (input) => accountRequest(path, { method: 'POST', body: input }),
    validate: (result) => !!result,
    onSuccess: () => {
      close();
      done();
    },
  });
  return (
    <ConfirmAction
      opened
      label={confirm}
      title={title}
      confirm={confirm}
      danger={danger}
      busy={command.busy ? 'Working…' : undefined}
      note={<Failure message={command.error} />}
      onToggle={(open) => !open && close()}
      onConfirm={() => command.submit(body)}
    >
      {children}
    </ConfirmAction>
  );
}

const More = ({ open, label, onClick }: { open: boolean; label: string; onClick(): void }) => (
  <button
    type="button"
    className="btn-icon admin-more"
    aria-label={label}
    title={label}
    aria-expanded={open}
    onClick={onClick}
  >
    ⋯
  </button>
);

function Account({
  account,
  role,
  reload,
}: {
  account: CreditAccount;
  role?: string;
  reload(): void;
}) {
  const [acting, setActing] = useState<string>();
  const close = () => setActing(undefined);
  const now = new Date().toISOString();
  const guard = (id: string, node: ReactNode, span: number) =>
    acting === id && (
      <tr className="admin-guard">
        <td colSpan={span}>{node}</td>
      </tr>
    );
  return (
    <section className="admin-account stack" aria-label={account.name}>
      <h3 className="admin-account-head">
        {account.name}
        {role && <span className="faint"> · {role}</span>}
        {account.projects.map((p) => (
          <span key={p.projectId} className="faint">
            {' '}
            · {p.name}
          </span>
        ))}
      </h3>
      {account.pools.length > 0 && (
        <Inner
          name="Providers"
          head={['Provider', 'Granted', 'Used', 'Reserved', 'Left', 'Expired', 'Revoked']}
        >
          {account.pools.map((pool) => (
            <tr key={pool.provider}>
              <td>{pool.provider}</td>
              <td className="num">{usd(pool.granted)}</td>
              <td className="num">{usd(pool.used)}</td>
              <td className="num">{usd(pool.reserved)}</td>
              <td className="num admin-left">{usd(pool.available)}</td>
              <td className="num faint">{usd(pool.expired)}</td>
              <td className="num faint">{usd(pool.revoked)}</td>
            </tr>
          ))}
        </Inner>
      )}
      {account.grants.length > 0 && (
        <Inner
          name="Grants"
          head={['Grant', 'Used', 'Left', 'Reserved', 'From', 'Expires', 'Reason', '']}
        >
          {account.grants.map((grant) => {
            const over = grant.revoked_at
              ? 'revoked'
              : grant.expires_at && grant.expires_at < now
                ? 'expired'
                : null;
            return (
              <Fragment key={grant.id}>
                <tr className={cx(over && 'admin-ended')}>
                  <td>
                    <span className="tabular">{usd(grant.amount)}</span> {grant.provider}
                    {grant.schedule_id && <span className="faint"> · scheduled</span>}
                  </td>
                  <td className="num">{usd(grant.used)}</td>
                  <td className="num admin-left">{usd(grant.available)}</td>
                  <td className="num">{usd(grant.reserved)}</td>
                  <td className="num">
                    <Day at={grant.valid_from} />
                  </td>
                  <td className="num">
                    {over ? <Tone tone="dim">{over}</Tone> : <Day at={grant.expires_at} />}
                  </td>
                  <td className="admin-clip admin-reason" title={grant.reason}>
                    {grant.reason}
                  </td>
                  <td className="admin-end">
                    {!over && (
                      <More
                        open={acting === grant.id}
                        label="Revoke grant"
                        onClick={() => setActing(acting === grant.id ? undefined : grant.id)}
                      />
                    )}
                  </td>
                </tr>
                {guard(
                  grant.id,
                  <Guarded
                    title="Revoke grant?"
                    confirm="Revoke grant"
                    danger
                    path={`/admin/credits/grants/${encodeURIComponent(grant.id)}/revoke`}
                    body={{}}
                    close={close}
                    done={reload}
                  >
                    <p>
                      {usd(grant.available)} left of {usd(grant.amount)} {grant.provider} ·{' '}
                      {account.name}
                    </p>
                  </Guarded>,
                  8,
                )}
              </Fragment>
            );
          })}
        </Inner>
      )}
      {account.schedules.length > 0 && (
        <Inner
          name="Schedules"
          head={['Schedule', 'Every', 'Starts', 'Ends', 'Lasts', 'State', '']}
        >
          {account.schedules.map((schedule) => (
            <Fragment key={schedule.id}>
              <tr>
                <td>
                  <span className="tabular">{usd(schedule.amount)}</span> {schedule.provider}
                </td>
                <td className="num">{schedule.cadence}</td>
                <td className="num">
                  <Day at={schedule.starts_at} />
                </td>
                <td className="num">
                  <Day at={schedule.ends_at} />
                </td>
                <td className="num">
                  {schedule.validity_periods === null
                    ? 'rolls over'
                    : `${schedule.validity_periods} ${schedule.validity_periods === 1 ? 'period' : 'periods'}`}
                </td>
                <td>
                  <Tone tone={schedule.enabled ? 'ok' : 'dim'}>
                    {schedule.enabled ? 'on' : 'paused'}
                  </Tone>
                </td>
                <td className="admin-end">
                  <More
                    open={acting === schedule.id}
                    label={schedule.enabled ? 'Pause schedule' : 'Resume schedule'}
                    onClick={() => setActing(acting === schedule.id ? undefined : schedule.id)}
                  />
                </td>
              </tr>
              {guard(
                schedule.id,
                <Guarded
                  title={schedule.enabled ? 'Pause schedule?' : 'Resume schedule?'}
                  confirm={schedule.enabled ? 'Pause schedule' : 'Resume schedule'}
                  path="/admin/credits/schedules"
                  // The same id with the same terms only switches a schedule on or off.
                  body={{
                    id: schedule.id,
                    accountId: account.accountId,
                    provider: schedule.provider,
                    amount: schedule.amount,
                    cadence: schedule.cadence,
                    startsAt: schedule.starts_at,
                    validityPeriods: schedule.validity_periods,
                    endsAt: schedule.ends_at,
                    enabled: !schedule.enabled,
                  }}
                  close={close}
                  done={reload}
                >
                  <p>
                    {usd(schedule.amount)} {schedule.provider} {schedule.cadence} · {account.name}
                  </p>
                </Guarded>,
                7,
              )}
            </Fragment>
          ))}
        </Inner>
      )}
      {account.budgets.length > 0 && (
        <Inner name="Budget caps" head={['Budget cap', 'Window', 'Measures', 'Provider']}>
          {account.budgets.map((budget) => (
            <tr key={budget.id}>
              <td>
                <span className="tabular">
                  {budget.cap === null
                    ? 'No cap'
                    : budget.metric === 'money'
                      ? usd(budget.cap)
                      : `${budget.cap} h`}
                </span>{' '}
                {words(budget.scope)}
              </td>
              <td className="num">{words(budget.window)}</td>
              <td className="num">{words(budget.metric)}</td>
              <td className="num">{budget.provider ?? 'all'}</td>
            </tr>
          ))}
        </Inner>
      )}
    </section>
  );
}

const CADENCES = ['once', 'daily', 'weekly', 'monthly'] as const;

/** One form assigns credit: a grant now, or a schedule that grants on every period. */
function Grant({
  holder,
  providers,
  reload,
}: {
  holder: Holder;
  providers: string[];
  reload(): void;
}) {
  const [accountId, setAccount] = useState(holder.accounts[0]?.account.accountId ?? '');
  const [provider, setProvider] = useState(providers[0] ?? '');
  const [amount, setAmount] = useState('');
  const [cadence, setCadence] = useState<(typeof CADENCES)[number]>('once');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const once = cadence === 'once';
  const command = useCommand<{ id: string }>({
    tool: 'credits.grant',
    // The grant's own id is its idempotency key, made once per submission and kept for a retry.
    idempotent: true,
    send: (body) =>
      accountRequest(body.cadence ? '/admin/credits/schedules' : '/admin/credits/grants', {
        method: 'POST',
        body,
      }),
    validate: (result) => typeof result?.id === 'string',
    onSuccess: () => {
      setAmount('');
      setUntil('');
      setReason('');
      reload();
    },
  });
  if (!holder.accounts.length || !providers.length) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    const end = until ? new Date(until).toISOString() : null;
    void command.submit(
      once
        ? { id, accountId, provider, amount, validFrom: at, ...(end && { expiresAt: end }), reason }
        : {
            id,
            accountId,
            provider,
            amount,
            cadence,
            startsAt: at,
            validityPeriods: 1,
            endsAt: end,
            enabled: true,
          },
    );
  };
  const choose = (
    label: string,
    value: string,
    set: (v: string) => void,
    options: [string, string][],
  ) => (
    <label>
      {label}
      <select
        className="input"
        value={value}
        disabled={command.locked}
        onChange={(event) => set(event.target.value)}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <form className="admin-grant" onSubmit={submit} aria-label={`Grant credits to ${holder.label}`}>
      <fieldset disabled={command.locked}>
        {holder.accounts.length > 1 &&
          choose(
            'Account',
            accountId,
            setAccount,
            holder.accounts.map(({ account }) => [account.accountId, account.name]),
          )}
        {choose(
          'Provider',
          provider,
          setProvider,
          providers.map((p) => [p, p]),
        )}
        <label>
          Amount
          <input
            className="input tabular admin-amount"
            inputMode="decimal"
            required
            pattern="\d+(\.\d{1,6})?"
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value.trim())}
          />
        </label>
        {choose(
          'Repeats',
          cadence,
          (v) => setCadence(v as typeof cadence),
          CADENCES.map((c) => [c, c]),
        )}
        <label>
          {once ? 'Expires' : 'Ends'}
          <input
            className="input"
            type="datetime-local"
            value={until}
            onChange={(event) => setUntil(event.target.value)}
          />
        </label>
        {once && (
          <label className="admin-grant-reason">
            Reason
            <input
              className="input"
              required
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        )}
      </fieldset>
      {/* Outside the fields it locks, so a request kept for a retry can be sent again. */}
      <Submit label="Grant" busy={command.busy} retry={command.retry} saving="Granting…" />
      <Failure message={command.error} />
    </form>
  );
}

export function CreditsView() {
  const credits = useTool<AdminCredits>('/admin/credits');
  const [open, setOpen] = useState<string>();
  const [query, setQuery] = useState('');
  const data = credits.data;
  const providers = data?.providers ?? [];
  const all = data ? holders(data) : [];
  const search = query.trim().toLowerCase();
  const shown = all.filter((holder) =>
    matches(search, [holder.label, ...holder.accounts.map(({ account }) => account.name)]),
  );
  const span = providers.length + 4;
  return (
    <div className="admin-page">
      <Lede
        title="Credits"
        facts={
          data && (
            <>
              <span>
                <b>{data.people.length}</b> {data.people.length === 1 ? 'person' : 'people'}
              </span>
              <span>
                <b>{data.accounts.length}</b> {data.accounts.length === 1 ? 'account' : 'accounts'}
              </span>
            </>
          )
        }
      >
        {all.length > 0 && (
          <Narrowing reset={query ? () => setQuery('') : undefined}>
            <SearchField label="Search people" value={query} onChange={setQuery} />
          </Narrowing>
        )}
        <Refresh read={credits} />
      </Lede>
      <div className="page-stage">
        <Loading read={credits} columns={5} />
        {data && (
          <div className="admin-surface">
            <table className="admin-table" aria-label="Credits">
              <thead>
                <tr>
                  <th>Person</th>
                  {providers.map((provider) => (
                    <th key={provider} className="num">
                      {provider}
                    </th>
                  ))}
                  <th className="num">Fleet today</th>
                  <th className="num">Fleet tokens</th>
                  <th className="num">Agent tokens</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((holder) => {
                  const unfolded = open === holder.key;
                  const fleet = holder.fleet;
                  const capped = !!fleet?.usdCap && fleet.usd >= fleet.usdCap;
                  return (
                    <Fragment key={holder.key}>
                      <tr
                        className={cx('admin-opens', unfolded && 'admin-unfolded')}
                        onClick={() => setOpen(unfolded ? undefined : holder.key)}
                      >
                        <td>
                          <button
                            type="button"
                            className="admin-name admin-toggle"
                            aria-expanded={unfolded}
                            onClick={(event) => {
                              event.stopPropagation();
                              setOpen(unfolded ? undefined : holder.key);
                            }}
                          >
                            {holder.label}
                          </button>
                        </td>
                        {providers.map((provider) => {
                          const pool = pooled(holder, provider);
                          return (
                            <td key={provider} className="num">
                              {pool ? (
                                <Of
                                  used={<span className="admin-left">{usd(pool.left)}</span>}
                                  of={usd(pool.granted)}
                                />
                              ) : (
                                <None />
                              )}
                            </td>
                          );
                        })}
                        <td className={cx('num', capped && 'status--bad')}>
                          {fleet ? (
                            <Of
                              used={usd(fleet.usd)}
                              of={fleet.usdCap === null ? undefined : usd(fleet.usdCap)}
                            />
                          ) : (
                            <None />
                          )}
                        </td>
                        <td className="num">
                          {fleet?.tokens ? (
                            <Of used={count(fleet.tokens.used)} of={count(fleet.tokens.limit)} />
                          ) : (
                            <None />
                          )}
                        </td>
                        <td className="num">
                          {holder.pi ? (
                            <Of used={count(holder.pi.used)} of={count(holder.pi.limit)} />
                          ) : (
                            <None />
                          )}
                        </td>
                      </tr>
                      {unfolded && (
                        <tr className="admin-holding">
                          <td colSpan={span}>
                            <div className="stack stack--lg">
                              {holder.accounts.map(({ account, role }) => (
                                <Account
                                  key={account.accountId}
                                  account={account}
                                  role={role}
                                  reload={credits.reload}
                                />
                              ))}
                              <Grant
                                holder={holder}
                                providers={providers}
                                reload={credits.reload}
                              />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {!shown.length && (
                  <tr>
                    <td colSpan={span} className="faint">
                      {query ? 'Nothing matches' : 'No one holds credit'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
