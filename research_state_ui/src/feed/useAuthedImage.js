import { useEffect, useState } from 'react';
import { feedApi } from './feedApi';

// Load a feed media path through an authenticated fetch and expose it as a
// blob: object URL. Needed because hosted control mode serves feed bytes behind
// the Bearer token, which a plain <img src> can't send. Revokes on unmount /
// path change. `failed` lets the card collapse a media box that will never
// fill, instead of leaving a permanently empty slab.
export function useAuthedImage(relPath) {
  const [state, setState] = useState({ url: null, failed: false });
  useEffect(() => {
    if (!relPath) { setState({ url: null, failed: false }); return undefined; }
    let active = true;
    let objectUrl = null;
    const controller = new AbortController();
    setState({ url: null, failed: false });
    feedApi.imageObjectUrl(relPath, { signal: controller.signal })
      .then((u) => {
        if (active) { objectUrl = u; setState({ url: u, failed: false }); }
        else { URL.revokeObjectURL(u); }
      })
      .catch(() => { if (active) setState({ url: null, failed: true }); });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [relPath]);
  return state;
}
