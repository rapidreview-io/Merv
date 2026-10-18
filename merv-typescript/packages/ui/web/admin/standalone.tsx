import { Link, useParams } from 'react-router-dom';
import { useTool } from '../api';
import { KV, PageLoad, RecordPage, timeRows, toneOf, words, type KVRow } from '../components';
import { Markdown } from '../markdown';
import { Tone, usd } from './parts';

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
  plan?: {
    question?: string;
    hypothesis?: string;
    metric?: string;
    baseline?: string;
    method?: string[];
    successCriteria?: string[];
    deliverables?: string[];
    turnaround?: string;
  } | null;
  progress?: {
    stage: string;
    attempt: number;
    maxAttempts: number;
    compute: { usd: number; limitUsd: number | null } | null;
    now: string | null;
  } | null;
  conversation?: { role: string; text: string }[];
  result?: { summary: string; artifacts: { id: string; title: string }[] } | null;
}

const list = (items?: string[]) =>
  items?.length ? (
    <ul className="admin-list">
      {items.map((item, at) => (
        <li key={at}>{item}</li>
      ))}
    </ul>
  ) : undefined;

/** A standalone experiment as its customer sees it, read-only: no token, no checkout, no chat. */
export function StandaloneView() {
  const { id = '' } = useParams();
  const read = useTool<Snapshot>(
    `/admin/standalone/${encodeURIComponent(id)}`,
    {},
    { every: 15_000 },
  );
  const back = <Link to="/admin">← Work</Link>;
  const s = read.data;
  if (!s)
    return (
      <PageLoad loading={read.loading} error={read.error} back={{ to: '/admin', label: 'Work' }} />
    );
  const plan = s.plan;
  const p = s.progress;
  const rows: KVRow[] = [
    !!s.planStatus && ['Plan', s.planStatus.replaceAll('_', ' ')],
    !!s.contractSummary && [
      'Price',
      usd(s.contractSummary.priceCents / 100) +
        (s.contractSummary.currency === 'usd' ? '' : ` ${s.contractSummary.currency}`),
    ],
    !!p && ['Stage', `${p.stage} · attempt ${p.attempt} of ${p.maxAttempts}`],
    !!p?.compute && [
      'Compute',
      `${usd(p.compute.usd)}${p.compute.limitUsd === null ? '' : ` of ${usd(p.compute.limitUsd)}`}`,
    ],
    !!p?.now && ['Now', p.now],
    ...timeRows(s.createdAt, s.workflow?.updatedAt),
  ];
  return (
    <RecordPage
      back={back}
      kind="experiments"
      name={s.name ?? plan?.question ?? 'Standalone experiment'}
      state={<Tone tone={toneOf(s.state)}>{words(s.state)}</Tone>}
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
              !!plan.question && ['Question', plan.question],
              !!plan.hypothesis && ['Hypothesis', plan.hypothesis],
              !!plan.metric && ['Metric', plan.metric],
              !!plan.baseline && ['Baseline', plan.baseline],
              !!plan.method?.length && ['Method', list(plan.method)],
              !!plan.successCriteria?.length && ['Success', list(plan.successCriteria)],
              !!plan.deliverables?.length && ['Deliverables', list(plan.deliverables)],
              !!plan.turnaround && ['Turnaround', plan.turnaround],
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
              <div key={at} className="admin-said">
                <span className="label">{message.role}</span>
                <Markdown source={message.text} />
              </div>
            ))}
          </>
        ) : undefined
      }
      details={<KV rows={rows} />}
    />
  );
}
