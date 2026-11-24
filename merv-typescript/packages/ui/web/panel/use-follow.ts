import { useRef, useEffect, useLayoutEffect, useState } from 'react';
import { preserveRichScroll } from './scroll-hold';

/** Keeps a list at its end while the reader is there; once they scroll up it stays put, and `behind` says that more
 *  came in below, for the "New activity" word a main thread shows. */
export function useFollow(ref: React.RefObject<HTMLDivElement | null>, ...changes: unknown[]) {
  const following = useRef(true);
  const height = useRef(0);
  const [behind, setBehind] = useState(false);
  useEffect(() => {
    if (ref.current) return preserveRichScroll(ref.current, () => following.current);
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (following.current) el.scrollTop = el.scrollHeight;
    else if (height.current && el.scrollHeight > height.current + 1) setBehind(true);
    height.current = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, changes);
  return {
    behind,
    onScroll: (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      height.current = el.scrollHeight;
      if (following.current) setBehind(false);
    },
    toEnd: () => {
      following.current = true;
      setBehind(false);
      ref.current?.scrollTo({ top: ref.current.scrollHeight });
    },
  };
}
