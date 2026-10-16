import { useEffect, useState } from 'react';

/** The `progress` the request snapshot carries once the experiment is paid for. */
export interface Progress {
  stage: 'planning' | 'running' | 'reviewing' | 'complete' | 'failed';
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

const STAGES = ['planning', 'running', 'reviewing', 'complete'] as const;
const WORD: Record<Progress['stage'], string> = {
  planning: 'Planning',
  running: 'Running',
  reviewing: 'Reviewing',
  complete: 'Complete',
  failed: 'Failed',
};

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

/** A minute's tick, so the clock moves between reads. */
function useNow(every = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

/**
 * Where a paid experiment stands: four stages, what it is doing now, time and compute against
 * their limits, scores as they finish, and what it has done. Nothing else.
 */
export function Status({ progress }: { progress: Progress }) {
  const now = useNow();
  const at = progress.stage === 'failed' ? 3 : STAGES.indexOf(progress.stage);
  const started = progress.startedAt ? Date.parse(progress.startedAt) : null;
  const elapsed = started ? now - started : null;
  const live = progress.stage === 'running' || progress.stage === 'reviewing';
  return (
    <section className="cx-status" aria-label="Status">
      <ol className="cx-stages">
        {STAGES.map((stage, index) => {
          const failed = progress.stage === 'failed' && index === 3;
          const state = failed ? 'bad' : index < at ? 'done' : index === at ? 'here' : 'ahead';
          return (
            <li
              key={stage}
              className={`cx-stage cx-stage--${state}`}
              aria-current={index === at ? 'step' : undefined}
            >
              <span className="cx-stage-dot" aria-hidden="true" />
              <span className="cx-stage-word">{failed ? WORD.failed : WORD[stage]}</span>
              {stage === 'running' && progress.attempt > 1 && (
                <span className="cx-stage-note">
                  Attempt {progress.attempt} of {progress.maxAttempts}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {progress.now && <p className="cx-now">{progress.now}</p>}

      <dl className="cx-meters">
        {elapsed !== null && (
          <div>
            <dt>Time</dt>
            <dd>
              {span(elapsed)}
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

      {progress.activity.length > 0 && (
        <ol className={`cx-activity${live ? ' cx-activity--live' : ''}`}>
          {progress.activity.map((line, index) => (
            <li key={`${line.at}-${index}`}>
              <time className="tabular" dateTime={line.at}>
                {started ? span(Date.parse(line.at) - started) : ''}
              </time>
              <span>{line.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
