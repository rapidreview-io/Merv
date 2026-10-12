import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { accountRequest, useScopeVersion } from '../api';
import type { ViewProps } from './index';

export function SandboxesView({ row }: ViewProps) {
  const scope = useScopeVersion();
  return <Console key={scope} path={row.path} />;
}

function Console({ path }: { path: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const destination = `/ui/${location.pathname.slice(path.length).replace(/^\//, '')}${location.search}`;
  const frame = useRef<HTMLIFrameElement>(null);
  const current = useRef(destination);
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [height, setHeight] = useState(700);

  useEffect(() => {
    let cancelled = false;
    const wanted = (current.current = destination);
    setSrc(undefined);
    setError(undefined);
    accountRequest<{ url: string }>('/sandboxes/console-session', {
      scoped: true,
      method: 'POST',
      body: { path: wanted },
    }).then(
      ({ url }) => {
        if (!cancelled) setSrc(`/sbx${wanted}${new URL(url, window.location.origin).hash}`);
      },
      (failure: unknown) => {
        if (!cancelled)
          setError(failure instanceof Error ? failure.message : 'Console unavailable');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [revision]);
  useEffect(() => {
    if (current.current !== destination) setRevision((value) => value + 1);
  }, [destination]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        !frame.current?.contentWindow ||
        event.source !== frame.current.contentWindow ||
        event.origin !== window.location.origin
      )
        return;
      const data = event.data;
      if (data?.type === 'sandboxes:navigate' && typeof data.path === 'string') {
        const next = data.path.replace(/^\/sbx(?=\/ui\/)/, '');
        if (
          !/^\/ui\/[\w\-./]*(\?[^#\s]*)?$/.test(next) ||
          next.includes('..') ||
          next === current.current
        )
          return;
        current.current = next;
        navigate(`${path}${next.slice(3).replace(/^\/(?=\?|$)/, '')}`);
      }
      if (
        data?.type === 'sandboxes:height' &&
        Number.isFinite(data.height) &&
        data.height >= 200 &&
        data.height <= 10000
      )
        setHeight(data.height);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [navigate, path]);

  return (
    <div className="sandboxes-console">
      <button
        type="button"
        className="btn sandboxes-reload"
        aria-label="Reload Sandboxes"
        onClick={() => setRevision((value) => value + 1)}
      >
        Reload
      </button>
      {error && <p role="alert">{error}</p>}
      {src && <iframe ref={frame} title="Sandboxes console" src={src} style={{ height }} />}
    </div>
  );
}
