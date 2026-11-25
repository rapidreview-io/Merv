/**
 * A project's main thread, on the web or a phone: the one conversation the person's own desktop
 * agent and Merv cloud both continue. The words are the page. While their Mac has the thread it
 * is read here; while the Mac is away, what they write is answered by Merv cloud.
 */
import { useEffect, useRef, useState } from 'react';
import { call, refreshTools, useTool } from '../api';
import { Markdown } from '../markdown';
import type { ViewProps } from './index';

interface Item {
  seq: number;
  engine: string;
  kind: 'person' | 'answer' | 'ready';
  text: string;
  at?: string;
}
interface Page {
  items: Item[];
  engine: 'mac' | 'cloud';
  available: boolean;
}
/** A job as job.read lists it: only what the line shows. */
interface Job {
  id: string;
  title: string;
  state: string;
  revision: number;
  code: { commit: string } | null;
  run: { costUsd: number | null; machineReleased: boolean } | null;
}

const UNDER_WAY = ['writing', 'running', 'reviewing'];

/** The project's jobs, one line each; a job under way has one red Stop. */
function Jobs() {
  const jobs = useTool<{ jobs: Job[] }>('job.read:list', {}, { every: 3000 });
  const [error, setError] = useState('');
  async function stop(job: Job) {
    setError('');
    const press = (revision: number) =>
      call('job.write:stop', {
        jobId: job.id,
        expectedRevision: revision,
        requestId: crypto.randomUUID(),
      });
    try {
      // The list may be a move behind (the machine starting bumps the revision): read the job
      // again and press once more, unless it is no longer under way.
      await press(job.revision).catch(async () => {
        const now = (await call<{ job: Job }>('job.read:get', { jobId: job.id })).job;
        if (UNDER_WAY.includes(now.state)) await press(now.revision);
      });
    } catch (failed) {
      setError(`${job.title} did not stop: ${(failed as Error).message}`);
    }
    refreshTools('job.read:list');
  }
  if (!jobs.data?.jobs.length) return null;
  return (
    <ul className="main-jobs">
      {jobs.data.jobs.map((job) => (
        <li key={job.id}>
          {[
            job.title,
            job.state,
            job.run?.costUsd != null && `$${job.run.costUsd.toFixed(2)}`,
            job.code && `code ${job.code.commit.slice(0, 7)}`,
            job.state === 'stopped' && job.run?.machineReleased && 'Machine released',
          ]
            .filter(Boolean)
            .join(' · ')}
          {UNDER_WAY.includes(job.state) && (
            <button type="button" className="main-stop" onClick={() => void stop(job)}>
              Stop
            </button>
          )}
        </li>
      ))}
      {error && <li className="main-error">{error}</li>}
    </ul>
  );
}

export function MainThreadView(_: ViewProps) {
  const page = useTool<Page>('main.read', { action: 'page', page: {} }, { every: 3000 });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState<string>();
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const items = page.data?.items ?? [];
  const last = items.at(-1)?.seq;
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [last, sending]);
  const mac = page.data?.engine === 'mac';

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(text);
    setDraft('');
    setError('');
    try {
      await call('main.write', { action: 'say', say: { text, requestId: crypto.randomUUID() } });
      refreshTools('main.read');
    } catch (failed) {
      setDraft(text);
      setError((failed as Error).message);
    } finally {
      setSending(undefined);
    }
  }

  return (
    <div className="main-thread">
      <p className="main-engine" data-engine={page.data?.engine}>
        <i aria-hidden="true" />
        {page.data ? (mac ? 'Your Mac' : 'Merv cloud') : ''}
      </p>
      <div className="main-lines">
        {items.map((item) =>
          item.kind === 'ready' ? (
            <p key={item.seq} className="main-mark">
              {item.text}
            </p>
          ) : item.kind === 'person' ? (
            <p key={item.seq} className="main-said">
              {item.text}
            </p>
          ) : (
            <div key={item.seq} className="main-answer">
              {item.engine === 'pi' && <span className="main-by">Merv cloud</span>}
              <Markdown source={item.text} />
            </div>
          ),
        )}
        {sending && (
          <>
            <p className="main-said">{sending}</p>
            <p className="main-mark">Merv cloud is answering…</p>
          </>
        )}
        {page.data && !items.length && !sending && (
          <p className="main-mark">Nothing said yet. Start on your Mac, or here.</p>
        )}
        <div ref={end} />
      </div>
      <Jobs />
      {error && (
        <p className="main-mark main-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="main-reply"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          rows={1}
          placeholder={mac ? 'Your Mac has this conversation' : 'Reply…'}
          disabled={mac || !!sending || page.data?.available === false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
      </form>
    </div>
  );
}
