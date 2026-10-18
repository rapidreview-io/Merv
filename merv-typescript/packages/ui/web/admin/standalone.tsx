import { Link, useParams } from 'react-router-dom';
import { useTool } from '../api';
import { KV, PageLoad, RecordPage, StatusPill, timeRows } from '../components';
import type { Delivered, Progress } from '../customer/status';
import { Markdown } from '../markdown';
import { usd } from './parts';

/** What a standalone experiment's customer is shown (Customer experiments' snapshot), as read here. */
interface Snapshot {
  name?: string;
  intent?: string;
  state: string;
  statusMessage?: string;
  createdAt?: string;
  workflow?: { updatedAt?: string };
  planStatus?: string;
  contractSummary?: { priceCents: number; currency: string } | null;
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
  const { plan, progress: p, contractSummary: price } = s;
  return (
    <RecordPage
      back={<Link to="/admin">← Work</Link>}
      kind="experiments"
      name={s.name ?? plan?.question ?? 'Standalone experiment'}
      state={<StatusPill value={s.state} />}
      standing={
        (s.intent || s.statusMessage) && (
          <>
            {s.intent && <span>{s.intent}</span>}
            {s.statusMessage && <span className="muted">{s.statusMessage}</span>}
          </>
        )
      }
      title="Plan"
      content={
        plan && (
          <KV
            rows={[
              ['Question', plan.question],
              ['Hypothesis', plan.hypothesis],
              ['Metric', plan.metric],
              ['Baseline', plan.baseline],
              ['Method', list(plan.method)],
              ['Success', list(plan.successCriteria)],
              ['Deliverables', list(plan.deliverables)],
              ['Turnaround', plan.turnaround],
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
            ['Plan', s.planStatus?.replaceAll('_', ' ')],
            !!price && [
              'Price',
              usd(price.priceCents / 100) + (price.currency === 'usd' ? '' : ` ${price.currency}`),
            ],
            !!p && ['Stage', `${p.stage} · attempt ${p.attempt} of ${p.maxAttempts}`],
            !!p?.compute && [
              'Compute',
              `${usd(p.compute.usd)}${p.compute.limitUsd === null ? '' : ` of ${usd(p.compute.limitUsd)}`}`,
            ],
            ['Now', p?.now],
            ...timeRows(s.createdAt, s.workflow?.updatedAt),
          ]}
        />
      }
    />
  );
}
