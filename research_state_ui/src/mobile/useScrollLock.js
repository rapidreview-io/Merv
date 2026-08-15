import { useEffect } from 'react';

/**
 * Reference-counted body scroll lock. Uses the position:fixed technique so iOS
 * Safari doesn't rubber-band the page *behind* an overlay. Counting makes
 * nesting safe — a node-detail sheet
 * opened from inside another sheet won't prematurely restore scroll.
 */
let lockCount = 0;
let savedScrollY = 0;
let savedStyles = null;

function lock() {
  if (lockCount === 0) {
    savedScrollY = window.scrollY;
    const body = document.body;
    savedStyles = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
    };
    body.style.position = 'fixed';
    body.style.top = `-${savedScrollY}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';
  }
  lockCount++;
}

function unlock() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0 && savedStyles) {
    const body = document.body;
    body.style.position = savedStyles.position;
    body.style.top = savedStyles.top;
    body.style.width = savedStyles.width;
    body.style.overflow = savedStyles.overflow;
    savedStyles = null;
    window.scrollTo(0, savedScrollY);
  }
}

/**
 * Whether anything currently holds the lock.
 *
 * Needed because the lock makes `window.scrollY` read 0 no matter where the
 * page actually sits — body is position:fixed, so the document stops
 * scrolling. Anything using scrollY===0 as a "we are at the top" test is
 * silently wrong while a sheet is open, which is exactly how pull-to-refresh
 * came to arm itself under an open sheet and push the graph down behind it.
 */
export function isScrollLocked() {
  return lockCount > 0;
}

export function useScrollLock(active) {
  useEffect(() => {
    if (!active) return undefined;
    lock();
    return unlock;
  }, [active]);
}
