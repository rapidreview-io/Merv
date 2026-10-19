import { useEffect, useState } from 'react';
import { cx, useNow } from '../components';
import { TimeInStatus, type Step } from '../process';
import { customerRequest } from './api';

/** The `progress` the request snapshot carries once the experiment is paid for. */
export interface Progress {
  stage: 'planning' | 'running' | 'reviewing' | 'complete' | 'failed';
  /** When the experiment first reached each stage. */
  entered?: Partial<Record<Progress['stage'], string>>;
  /** The run stopped and resumes by itself shortly. */
  waiting?: boolean;
  attempt: number;
  maxAttempts: number;
  startedAt: string | null;
  maxWallMs: number | null;
  compute: { usd: number; limitUsd: number | null } | null;
  now: string | null;
  step: { done: number; total: number } | null;
  results: { name: string; score: number; total: number }[];
  activity: { at: string; text: string }[];
}

/** `result` on the request snapshot: the delivered summary, report pages and files. */
export interface Delivered {
  summary: string;
  pages?: string[];
  artifacts: { id: string; title: string }[];
}

const STAGES = ['planning', 'running', 'reviewing', 'complete'] as const;
type Stage = (typeof STAGES)[number];

/** A delivered artifact's short-lived download address, read once it is wanted. */
function useDownload(id: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    customerRequest<{ download?: { url?: string } }>(`/artifacts/${encodeURIComponent(id)}`)
      .then((got) => live && setUrl(got.download?.url ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id]);
  return url;
}

function Page({ id, index }: { id: string; index: number }) {
  const url = useDownload(id);
  return url ? (
    <img className="cx-report-page" src={url} alt={`Report page ${index + 1}`} />
  ) : (
    <div className="cx-report-page cx-report-page--loading" aria-hidden="true" />
  );
}

async function open(id: string) {
  // Opened before the address is known, so the browser keeps it as the click's own window.
  const tab = window.open('', '_blank');
  try {
    const got = await customerRequest<{ download?: { url?: string } }>(
      `/artifacts/${encodeURIComponent(id)}`,
    );
    if (got.download?.url && tab) tab.location.href = got.download.url;
    else tab?.close();
  } catch {
    tab?.close();
  }
}

/** The finished experiment: the report as its pages, and the report to keep as a PDF. The
 *  executor's own handoff summary is for Merv's reviewer, not shown here. */
function Results({ result }: { result: Delivered }) {
  const pdf = result.artifacts.find((artifact) => artifact.title === 'Report (PDF)');
  return (
    <section className="cx-results-delivered" aria-label="Results">
      {pdf && (
        <div className="cx-deliverables">
          <button type="button" className="btn btn--primary" onClick={() => void open(pdf.id)}>
            Download PDF
          </button>
        </div>
      )}
      {!!result.pages?.length && (
        <div className="cx-report">
          {result.pages.map((id, index) => (
            <Page key={id} id={id} index={index} />
          ))}
        </div>
      )}
    </section>
  );
}

const span = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};
const dollars = (usd: number) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: usd < 10 ? 2 : 0,
  }).format(usd);

/**
 * Where a paid experiment stands, on the same stage card as a record in the app: its four
 * stages sideways, how long it stood in each, and what the worker reported while it was there
 * under the stage; then what it is doing now, time and compute against their limits, and
 * scores as they finish. Complete, the report is the one thing to read, its files beside it,
 * under tabs that stay at the top of the view.
 */
export function Status({ progress, result }: { progress: Progress; result?: Delivered | null }) {
  const now = useNow(30_000);
  const at = progress.stage === 'failed' ? 3 : STAGES.indexOf(progress.stage);
  const started = progress.startedAt ? Date.parse(progress.startedAt) : null;
  const elapsedMs = started ? now - started : null;
  const live = progress.stage === 'running' || progress.stage === 'reviewing';
  const entered = progress.entered ?? {};
  // Each stage from when it was reached to when the next was, the one in hand until now; a
  // line the worker wrote stands under the stage the experiment was in then.
  const from = (index: number) => {
    const stage = index === 3 && progress.stage === 'failed' ? 'failed' : STAGES[index]!;
    return entered[stage] ? Date.parse(entered[stage]!) : null;
  };
  const steps: Step[] = STAGES.map((stage, index) => {
    const failed = progress.stage === 'failed' && index === 3;
    return {
      state: failed ? 'failed' : stage,
      end: index === 3,
      stopped: failed,
      current: index === at,
      entered: index <= at,
    };
  });
  const spent = new Map<string, number>();
  for (let index = 0; index <= at; index++) {
    const since = from(index);
    const until = index === at ? now : from(index + 1);
    if (since && until && until > since) spent.set(steps[index]!.state, until - since);
  }
  const under = (state: string) => {
    const index = steps.findIndex((step) => step.state === state);
    const since = from(index);
    const until = index < 3 ? from(index + 1) : null;
    const lines = progress.activity.filter((line) => {
      const when = Date.parse(line.at);
      return since !== null && when >= since && (until === null || when < until);
    });
    return lines.length ? (
      <ol className="thread thread--stage">
        {[...lines].reverse().map((line, index) => (
          <li className="feed-entry feed-line" key={`${line.at}-${index}`}>
            <span className="feed-mark">
              <span className="thread-dot" />
            </span>
            <p className="feed-said">{line.text}</p>
            {started && (
              <time className="feed-when tabular" dateTime={line.at}>
                {span(Date.parse(line.at) - started)}
              </time>
            )}
          </li>
        ))}
      </ol>
    ) : null;
  };
  const delivered = progress.stage === 'complete' && result;
  const [tab, setTab] = useState<'document' | 'artifacts'>('document');
  return (
    <section className={cx('cx-run', live && 'cx-run--live')} aria-label="Status">
      <TimeInStatus
        steps={steps}
        spent={spent}
        strip
        aside={(state) =>
          state === 'running' && progress.attempt > 1
            ? `Attempt ${progress.attempt} of ${progress.maxAttempts}`
            : null
        }
        below={under}
      />

      {progress.now && <p className="cx-now">{progress.now}</p>}

      <dl className="cx-meters">
        {elapsedMs !== null && (
          <div>
            <dt>Time</dt>
            <dd>
              {span(elapsedMs)}
              {progress.maxWallMs ? ` of ${span(progress.maxWallMs)}` : ''}
            </dd>
          </div>
        )}
        {progress.compute && (
          <div>
            <dt>Compute</dt>
            <dd>
              {dollars(progress.compute.usd)}
              {progress.compute.limitUsd ? ` of ${dollars(progress.compute.limitUsd)}` : ''}
            </dd>
          </div>
        )}
        {progress.step && (
          <div>
            <dt>Done</dt>
            <dd>
              {progress.step.done} of {progress.step.total}
            </dd>
          </div>
        )}
      </dl>

      {progress.results.length > 0 && (
        <table className="cx-results">
          <tbody>
            {progress.results.map((result) => (
              <tr key={result.name}>
                <th scope="row">{result.name}</th>
                <td className="tabular">
                  {result.score} / {result.total}
                </td>
                <td className="cx-results-bar" aria-hidden="true">
                  <span
                    style={{ width: `${Math.min(100, (100 * result.score) / result.total)}%` }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {delivered && (
        <>
          <div className="unit-pin">
            <div className="tabs tabs--strip unit-tabs" role="group" aria-label="Results">
              <button
                type="button"
                aria-pressed={tab === 'document'}
                onClick={() => setTab('document')}
              >
                Document
              </button>
              <button
                type="button"
                aria-pressed={tab === 'artifacts'}
                onClick={() => setTab('artifacts')}
              >
                Artifacts<span className="state-n">{result.artifacts.length}</span>
              </button>
            </div>
          </div>
          {tab === 'document' ? (
            <Results result={result} />
          ) : (
            <ul className="unit-rows">
              {result.artifacts.map((artifact) => (
                <li key={artifact.id}>
                  <button type="button" className="unit-row" onClick={() => void open(artifact.id)}>
                    <span className="unit-row-name">{artifact.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
