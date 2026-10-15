import { useState } from 'react';
import { Icon } from '../icons';
import { safely } from '../api';
import { fromDrop } from './uploads';

/**
 * /start: the customer page before there is a request. It looks as a request's page does when
 * it opens — the drop zone over the chat — and the first message or the first files make the
 * request (POST /start/requests, public intake). The page then becomes that request's page in
 * place: its address and capability are the ones the request's link carries, and files dropped
 * here are uploaded there.
 */

/** Files dropped on /start, uploaded once the request they made is open. */
let pending: { file: File; path: string }[] = [];
export const takePending = () => {
  const files = pending;
  pending = [];
  return files;
};

/** The client request id, kept for this tab so a retried creation is the same request. */
const KEY = 'merv:start-request';
const clientRequest = () => {
  const kept = safely(() => sessionStorage.getItem(KEY), null);
  if (kept) return kept;
  const made = crypto.randomUUID();
  safely(() => sessionStorage.setItem(KEY, made));
  return made;
};

const clip = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
};

/** Makes the request, and answers its id once its link is this page's address. */
async function create(message?: string): Promise<string> {
  const response = await fetch('/start/requests', {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: clientRequest(),
      title: message ? clip(message) : 'New experiment',
      ...(message ? { message } : {}),
    }),
  });
  const body = (await response.json().catch(() => null)) as {
    id?: string;
    customerUrl?: string;
    error?: { message?: string };
  } | null;
  if (!response.ok || !body?.id || !body.customerUrl)
    throw new Error(
      response.status === 429
        ? 'Merv is at capacity today. Try again tomorrow.'
        : (body?.error?.message ?? 'Couldn’t start the experiment. Try again.'),
    );
  const link = new URL(body.customerUrl, location.origin);
  // The request's own link, fragment and all: the page reads its capability from there.
  history.replaceState(null, '', link.pathname + link.hash);
  safely(() => sessionStorage.removeItem(KEY));
  return body.id;
}

export function Start({ opened }: { opened(id: string): void }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
  const begin = async (message?: string, files: { file: File; path: string }[] = []) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const id = await create(message);
      pending = files;
      opened(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t start the experiment.');
      setBusy(false);
    }
  };
  const send = () => {
    const text = draft.trim();
    if (text) void begin(text);
  };
  return (
    <div className="cx-arrive">
      <button
        type="button"
        className={`cx-drop${over ? ' cx-drop--over' : ''}`}
        disabled={busy}
        onClick={() => void begin()}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          void fromDrop(event.dataTransfer).then((files) => begin(undefined, files));
        }}
      >
        <span className="cx-drop-title">Chug anything</span>
        <Icon name="upload" size={20} className="cx-drop-icon" />
        <span className="cx-drop-kinds">datasets, papers, content files</span>
      </button>
      <section className="cx-chat" aria-labelledby="cx-chat-title">
        <h2 className="cx-chat-title" id="cx-chat-title">
          Chat
        </h2>
        <div className="cx-start-space" />
        {error && (
          <p className="pi-error" role="alert">
            {error}
          </p>
        )}
        <form
          className="pi-compose"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <label htmlFor="cx-start-draft" className="sr-only">
            What do you want to learn?
          </label>
          <textarea
            id="cx-start-draft"
            className="textarea"
            rows={3}
            maxLength={32_000}
            value={draft}
            readOnly={busy}
            placeholder="What do you want to learn?"
            onChange={(event) => setDraft(event.target.value)}
            enterKeyHint="send"
            onKeyDown={(event) => {
              const { key, shiftKey, altKey, metaKey, ctrlKey, nativeEvent } = event;
              if (key !== 'Enter' || shiftKey || altKey || metaKey || ctrlKey) return;
              if (nativeEvent.isComposing) return;
              event.preventDefault();
              send();
            }}
          />
          <div className="pi-compose-actions">
            <button className="btn btn--primary" type="submit" disabled={busy || !draft.trim()}>
              {busy ? 'Starting…' : 'Send'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
