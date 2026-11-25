/**
 * A project's main thread, on the web or a phone: the one conversation the person's own desktop
 * agent and Merv cloud both continue. The words are the page. While their Mac has the thread it
 * is read here; while the Mac is away, what they write is answered by Merv cloud.
 */
import { useEffect, useRef, useState } from 'react';
import { call, refreshTools, useTool } from '../api';
import { Markdown } from '../markdown';
import type { ViewProps } from './index';
import './main-thread.css';

interface Item {
  seq: number;
  engine: string;
  kind: 'person' | 'answer' | 'ready';
  text: string;
}
interface Page {
  items: Item[];
  engine: 'mac' | 'cloud';
  available: boolean;
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
