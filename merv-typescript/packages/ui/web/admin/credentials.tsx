import { Fragment } from 'react';
import type { AdminCredentialsV2, PlatformSecret, ProviderKey } from '@merv/admin/models';
import { useTool } from '../api';
import { Ago, LoadState, Ruled, Word, col, cx, stamp, toneOf, words } from '../components';
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

const SECRETS = [
  // What it is for, in its owner's words; the config path is a hover title.
  col<PlatformSecret>('purpose', 'For', (c) => (
    <span title={`${c.plugin} · ${c.field}`}>{c.purpose}</span>
  )),
  col<PlatformSecret>('env', 'Variable', (c) => <Env name={c.env} />),
  col<PlatformSecret>('state', 'State', (c) => state(c.set, c.dead)),
  // Another name that holds the same value; the same name read by another plugin is no news.
  fact<PlatformSecret>('shared', 'Same as', (c) => {
    const others = [...new Set(c.sharedWith.map((other) => other.env))].filter(
      (env) => env !== c.env,
    );
    return others.length ? others.map((env) => <Env key={env} name={env} />) : null;
  }),
  fig<PlatformSecret>('changed', 'Changed', (c) => c.lastChanged && <Ago at={c.lastChanged} />),
  fig<PlatformSecret>('ok', 'Last ok', ({ lastOk: ok }) =>
    ok ? (
      <span title={`${ok.relay} · ${ok.model}`}>
        <Ago at={ok.at} />
      </span>
    ) : null,
  ),
  fig<PlatformSecret>('failure', 'Last failure', ({ lastFailure: failed, lastOk: ok, dead }) =>
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
const PROVIDERS = [
  col<ProviderKey>('provider', 'Provider', (k) => <span title={k.plugin}>{k.provider}</span>),
  col<ProviderKey>('field', 'Key', (k) => <span title={k.field}>{k.description || k.field}</span>),
  col<ProviderKey>('whose', 'Whose', (k) => k.namespace ?? 'Platform'),
  col<ProviderKey>('state', 'State', (k) => state(k.present)),
  fact<ProviderKey>(
    'health',
    'Health',
    (k) =>
      k.health && (
        <Word tone={toneOf(k.health)} value={k.health} title={k.healthReason ?? undefined} />
      ),
  ),
  fig<ProviderKey>('verified', 'Verified', (k) => k.verifiedAt && <Ago at={k.verifiedAt} />),
];
type Minted = AdminCredentialsV2['minted'][number];
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
  const read = useTool<AdminCredentialsV2>('/admin/credentials', {}, { every: 60_000 });
  const groups = read.data?.groups ?? [];
  const all = groups.flatMap((g) => g.secrets);
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
      {groups.map(({ purpose, secrets }) => (
        <section className="stack admin-purpose" key={purpose}>
          <h2 className="section-title admin-group">{purpose}</h2>
          <Ruled
            label={purpose}
            template="minmax(0, 2fr) minmax(0, 1.6fr) 84px minmax(0, 1.4fr) 76px 76px minmax(0, 1fr)"
            columns={SECRETS}
            rows={secrets}
            keyOf={(c) => `${c.plugin}:${c.field}`}
            row={(c) => ({ className: cx(c.dead && 'admin-dead') })}
          />
        </section>
      ))}
      {!!read.data?.providers.length && (
        <section className="stack admin-purpose">
          <h2 className="section-title admin-group">Sandbox provider keys</h2>
          <Ruled
            label="Sandbox provider keys"
            template="minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr) 84px 104px 104px"
            columns={PROVIDERS}
            rows={read.data.providers}
            keyOf={(k) => `${k.provider}:${k.namespace ?? ''}:${k.field}`}
          />
        </section>
      )}
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
