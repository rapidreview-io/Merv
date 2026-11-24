import { useEffect, useRef } from 'react';

/** While a screen is open over the board, the phone's own back closes it instead of leaving the page. */
// Open screens share one disposable entry. Router push/replace writes fresh state, relinquishing it.
let over = 0;
const ownsBackEntry = () => history.state?.mervBack === true;
const guardBack = () => {
  if (!ownsBackEntry()) history.pushState({ ...history.state, mervBack: true }, '');
};
export function useBackCloses(open: boolean, close: () => void | boolean) {
  const shut = useRef(close);
  shut.current = close;
  useEffect(() => {
    if (!open) return;
    if (!over++) guardBack();
    const back = () => {
      // Returning true means Back left a screen open: guard its next Back too.
      if (shut.current() === true) guardBack();
    };
    window.addEventListener('popstate', back);
    return () => {
      window.removeEventListener('popstate', back);
      // A screen that takes this one's place (the list opening Merv's chat) keeps the same entry.
      queueMicrotask(() => {
        if (!--over && ownsBackEntry()) history.back();
      });
    };
  }, [open]);
}
