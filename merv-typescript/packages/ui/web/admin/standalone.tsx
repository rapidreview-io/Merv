import { Link, useParams } from 'react-router-dom';
import { useTool } from '../api';
import { KV, PageLoad, RecordPage, timeRows } from '../components';
import { limitLine } from '../customer/plan-card';
import type { Delivered, Progress } from '../customer/status';
import { Markdown } from '../markdown';
import { formatMoney } from '../views/remote-fields';
import { State } from './parts';

/** What a standalone experiment's customer is shown (Customer experiments' snapshot), as read here. */
interface Snapshot {
  title: string;
  waits?: 'approval' | 'payment' | null;
  intent?: string;
  state: string;
  statusMessage?: string;
  email?: string | null;
  createdAt?: string;
  workflow?: { updatedAt?: string };
  planStatus?: string;
  contract?: { question?: string; criteria?: string[] } | null;
  contractSummary?: { priceCents: number; currency: string; limits?: Record<string, number> };
  plan?: Partial<
    Record<'question' | 'hypothesis' | 'metric' | 'baseline' | 'turnaround', string> &
      Record<'method' | 'successCriteria' | 'deliverables', string[]>
  > | null;
  progress?: Progress | null;
  conversation?: { role: string; text: string }[];
  result?: Delivered | null;
}

const list = (items?: string[]) =>
  items?.length ? <Markdown source={items.map((item) => `- ${item}`).join('\n')} /> : undefined;

/** A standalone experiment as its customer sees it, read-only: no token, no checkout, no chat. */
export function StandaloneView() {
  const { id = '' } = useParams();
  const read = useTool<Snapshot>(
    `/admin/standalone/${encodeURIComponent(id)}`,
    {},
    { every: 15_000 },
  );
  const s = read.data;
  if (!s)
    return (
      <PageLoad loading={read.loading} error={read.error} back={{ to: '/admin', label: 'Work' }} />
    );
  const { plan, contract: c, progress: p, contractSummary: price } = s;
  return (
    <RecordPage
      back={<Link to="/admin">← Work</Link>}
      kind="experiments"
      name={s.title}
      state={<State value={s.state} need={!!s.waits && 'warn'} />}
      standing={
        (s.waits || s.intent || s.statusMessage) && (
          <>
            {s.waits && <span className="status--warn">waits on {s.waits}</span>}
            {s.intent && <span>{s.intent}</span>}
            {s.statusMessage && <span className="muted">{s.statusMessage}</span>}
          </>
        )
      }
      title="Plan"
      content={
        (plan || c) && (
          <KV
            rows={[
              ['Question', plan?.question ?? c?.question],
              ['Hypothesis', plan?.hypothesis],
              ['Metric', plan?.metric],
              ['Baseline', plan?.baseline],
              ['Method', list(plan?.method)],
              ['Success', list(plan?.successCriteria ?? c?.criteria)],
              ['Deliverables', list(plan?.deliverables)],
              ['Turnaround', plan?.turnaround],
              ['Limits', price?.limits && limitLine(price.limits)],
            ]}
          />
        )
      }
      history={
        s.result || s.conversation?.length ? (
          <>
            {s.result && <Markdown source={s.result.summary} />}
            {s.result?.artifacts.map((artifact) => (
              <p key={artifact.id} className="muted">
                {artifact.title}
              </p>
            ))}
            {s.conversation?.map((message, at) => (
              <div key={at} className="stack">
                <span className="label">{message.role}</span>
                <Markdown source={message.text} />
              </div>
            ))}
          </>
        ) : undefined
      }
      details={
        <KV
          rows={[
            ['Customer', s.email],
            ['Plan', s.planStatus?.replaceAll('_', ' ')],
            !!price && ['Price', formatMoney(price.priceCents / 100, undefined, price.currency)],
            !!p && ['Stage', `${p.stage} · attempt ${p.attempt} of ${p.maxAttempts}`],
            !!p?.compute && [
              'Compute',
              formatMoney(p.compute.usd, undefined, 'USD', p.compute.limitUsd ?? undefined),
            ],
            ['Now', p?.now],
            ...timeRows(s.createdAt, s.workflow?.updatedAt),
          ]}
        />
      }
    />
  );
}
