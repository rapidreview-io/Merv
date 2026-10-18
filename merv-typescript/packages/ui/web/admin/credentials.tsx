import { Fragment } from 'react';
import type { AdminCredential, AdminCredentials } from '@merv/admin/models';
import { useTool } from '../api';
import { Ago, KV, LoadState, Ruled, Word, col, cx, stamp, toneOf, words } from '../components';
import { elapsed } from '../liveness';
import { Head, None, fact, fig } from './parts';

/** An env name, which may break after an underscore and nowhere inside a word. */
const Env = ({ name }: { name: string }) => (
  <span className="mono">
    {name.split(/(?<=_)/).map((part, at) => (
      <Fragment key={at}>
        {at > 0 && <wbr />}
        {part}
      </Fragment>
    ))}
  </span>
);
/** Set, unset, or dead: a state a row is in, in its colour; red is a dead key's alone. */
const state = (set: boolean | null, dead = false) =>
  set === null ? (
    <None />
  ) : (
    <Word tone={dead ? 'bad' : set ? 'ok' : 'dim'} value={dead ? 'dead' : set ? 'set' : 'unset'} />
  );

const COLUMNS = [
  col<AdminCredential>('env', 'Credential', (c) => <Env name={c.env} />),
  col<AdminCredential>('plugin', 'Used by', (c) => (
    <span title={`${c.plugin} · ${c.field}`}>{c.plugin}</span>
  )),
  col<AdminCredential>('state', 'State', (c) => state(c.set, c.dead)),
  // Another name that holds the same value; the same name read by another plugin is no news.
  fact<AdminCredential>('fingerprint', 'Fingerprint', (c) =>
    c.fingerprint ? (
      <span>
        <span className="mono">{c.fingerprint}</span>
        {c.sharedWith
          .filter((other) => other.env !== c.env)
          .map((other) => (
            <span key={other.env} className="faint">
              {' = '}
              <Env name={other.env} />
            </span>
          ))}
      </span>
    ) : null,
  ),
  fig<AdminCredential>('changed', 'Changed', (c) => c.lastChanged && <Ago at={c.lastChanged} />),
  fig<AdminCredential>('ok', 'Last ok', ({ lastOk: ok }) =>
    ok ? (
      <span title={`${ok.relay} · ${ok.model}`}>
        <Ago at={ok.at} />
      </span>
    ) : null,
  ),
  fig<AdminCredential>('failure', 'Last failure', ({ lastFailure: failed, lastOk: ok, dead }) =>
    failed ? (
      <span
        className={dead || !ok || failed.at > ok.at ? 'status--bad' : 'faint'}
        title={`${failed.status ?? ''} ${failed.code ?? ''} · ${failed.relay} · ${failed.model}`}
      >
        {failed.code ?? failed.status} <Ago at={failed.at} />
      </span>
    ) : null,
  ),
];
type Minted = AdminCredentials['minted'][number];
const MINTED = [
  col<Minted>('owner', 'Minted by', (m) => m.owner),
  col<Minted>('kind', 'Kind', (m) => words(m.kind)),
  fig<Minted>('live', 'Live', (m) => m.live),
  fig<Minted>('expiry', 'Next expiry', ({ soonestExpiry: at }) =>
    at ? (
      <time dateTime={at} title={stamp(at)}>
        in {elapsed(Date.parse(at) - Date.now())}
      </time>
    ) : null,
  ),
  fig<Minted>('revoked', 'Revoked 24h', (m) => Number(m.revokedLastDay) || null),
  fig<Minted>('issued', 'Last issued', (m) => <Ago at={m.newestIssued} />),
];

export function CredentialsView() {
  const read = useTool<AdminCredentials>('/admin/credentials', {}, { every: 60_000 });
  const groups = read.data?.groups ?? [];
  const all = groups.flatMap((g) => g.credentials);
  const unset = all.filter((c) => !c.set).length;
  const dead = all.filter((c) => c.dead).length;
  return (
    <div className="page-stage stack stack--lg">
      <Head
        title="Credentials"
        facts={
          read.data && [
            [all.length - unset, 'set'],
            unset > 0 && [unset, 'unset'],
            dead > 0 && [dead, 'dead', true],
          ]
        }
      />
      <LoadState {...read} columns={6} />
      {groups.map(({ purpose, provider: p, credentials }) => (
        <section className="stack admin-purpose" key={p ? `provider:${p.name}` : purpose}>
          <h2 className="section-title admin-group">
            {p ? (
              <>
                {p.name}{' '}
                {p.health && (
                  <Word
                    tone={toneOf(p.health.status)}
                    value={p.health.status}
                    title={[p.health.message, p.health_reason].filter(Boolean).join(' · ')}
                  />
                )}{' '}
                {!p.enabled && <Word tone="dim" value="disabled" />}
                {p.verified_at && (
                  <span className="faint">
                    {' '}
                    verified <Ago at={p.verified_at} />
                  </span>
                )}
              </>
            ) : (
              purpose
            )}
          </h2>
          {credentials.length > 0 && (
            <Ruled
              label={p?.name ?? purpose}
              template="minmax(0, 2fr) minmax(0, 0.8fr) 84px minmax(0, 2fr) 76px 76px minmax(0, 1fr)"
              columns={COLUMNS}
              rows={credentials}
              keyOf={(c) => `${c.env}:${c.field}`}
              row={(c) => ({ className: cx(c.dead && 'admin-dead') })}
            />
          )}
          {/* A provider whose key is sealed in its row says which fields it holds. */}
          {p && !credentials.length && (
            <KV rows={p.fields.map((field) => [field.name, state(field.present)])} />
          )}
        </section>
      ))}
      {!!read.data?.minted.length && (
        <section className="stack">
          <h2 className="section-title">Minted</h2>
          <Ruled
            label="Minted credentials"
            template="minmax(0, 1fr) minmax(0, 1.4fr) 64px 104px 104px 104px"
            rows={read.data.minted}
            keyOf={(m) => `${m.owner}:${m.kind}`}
            columns={MINTED}
          />
        </section>
      )}
    </div>
  );
}
