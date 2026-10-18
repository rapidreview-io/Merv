import { Fragment } from 'react';
import type { AdminCredential, AdminCredentials } from '@merv/admin/models';
import { useTool } from '../api';
import { Ago, KV, LoadState, PageHeader, Ruled, Word, col, cx, toneOf, words } from '../components';
import { Facts, In, None, fig } from './parts';

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

const COLUMNS = [
  col<AdminCredential>('env', 'Credential', (c) => <Env name={c.env} />),
  col<AdminCredential>('plugin', 'Used by', (c) => (
    <span title={`${c.plugin} · ${c.field}`}>{c.plugin}</span>
  )),
  col<AdminCredential>('state', 'State', (c) => (
    <Word
      tone={c.set && !c.dead ? 'ok' : 'bad'}
      value={c.dead ? 'dead' : c.set ? 'set' : 'missing'}
    />
  )),
  col<AdminCredential>('fingerprint', 'Fingerprint', (c) => {
    // Another name that holds the same value; the same name read by another plugin is no news.
    const others = c.sharedWith.filter((o) => o.env !== c.env);
    return c.fingerprint ? (
      <span>
        <span className="mono">{c.fingerprint}</span>
        {others.map((o) => (
          <span key={o.env} className="faint">
            {' = '}
            <Env name={o.env} />
          </span>
        ))}
      </span>
    ) : (
      <None />
    );
  }),
  fig<AdminCredential>('changed', 'Changed', (c) =>
    c.lastChanged ? <Ago at={c.lastChanged} /> : <None />,
  ),
  fig<AdminCredential>('ok', 'Last ok', ({ lastOk }) =>
    lastOk ? (
      <span title={`${lastOk.relay} · ${lastOk.model}`}>
        <Ago at={lastOk.at} />
      </span>
    ) : (
      <None />
    ),
  ),
  fig<AdminCredential>('failure', 'Last failure', ({ lastFailure: failed }) =>
    failed ? (
      <span
        className="status--bad"
        title={`${failed.status ?? ''} ${failed.code ?? ''} · ${failed.relay} · ${failed.model}`}
      >
        {failed.code ?? failed.status} <Ago at={failed.at} />
      </span>
    ) : (
      <None />
    ),
  ),
];
const TEMPLATE = 'minmax(0, 2fr) minmax(0, 0.8fr) 84px minmax(0, 2fr) 76px 76px minmax(0, 1fr)';
type Minted = AdminCredentials['minted'][number];

export function CredentialsView() {
  const read = useTool<AdminCredentials>('/admin/credentials', {}, { every: 60_000 });
  const data = read.data;
  const groups = data?.groups ?? [];
  const all = groups.flatMap((g) => g.credentials);
  const missing = all.filter((c) => !c.set).length;
  const dead = all.filter((c) => c.dead).length;
  return (
    <div className="page-stage stack stack--lg">
      <PageHeader
        title="Credentials"
        summary={
          data && (
            <Facts
              facts={[
                [all.length - missing, 'set'],
                missing > 0 && [missing, 'missing', true],
                dead > 0 && [dead, 'dead', true],
              ]}
            />
          )
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
              template={TEMPLATE}
              columns={COLUMNS}
              rows={credentials}
              keyOf={(c) => `${c.env}:${c.field}`}
              row={(c) => ({ className: cx(c.dead && 'admin-dead') })}
            />
          )}
          {/* A provider whose key is sealed in its row says which fields it holds. */}
          {p && !credentials.length && (
            <KV
              rows={p.fields.map((field) => [
                field.name,
                field.present === null ? (
                  <None />
                ) : (
                  <Word
                    tone={field.present ? 'ok' : 'bad'}
                    value={field.present ? 'set' : 'missing'}
                  />
                ),
              ])}
            />
          )}
        </section>
      ))}
      {!!data?.minted.length && (
        <section className="stack">
          <h2 className="section-title">Minted</h2>
          <Ruled
            label="Minted credentials"
            template="minmax(0, 1fr) minmax(0, 1.4fr) 64px 104px 104px 104px"
            rows={data.minted}
            keyOf={(m) => `${m.owner}:${m.kind}`}
            columns={[
              col<Minted>('owner', 'Minted by', (m) => m.owner),
              col<Minted>('kind', 'Kind', (m) => words(m.kind)),
              fig<Minted>('live', 'Live', (m) => m.live),
              fig<Minted>('expiry', 'Next expiry', (m) =>
                m.soonestExpiry ? <In at={m.soonestExpiry} /> : <None />,
              ),
              fig<Minted>('revoked', 'Revoked 24h', (m) =>
                Number(m.revokedLastDay) ? m.revokedLastDay : <None />,
              ),
              fig<Minted>('issued', 'Last issued', (m) => <Ago at={m.newestIssued} />),
            ]}
          />
        </section>
      )}
    </div>
  );
}
