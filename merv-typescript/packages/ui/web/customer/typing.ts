import { useEffect, useState } from 'react';

/**
 * A placeholder that types itself out, then keeps a blinking caret, so a first-time visitor's eye
 * goes to the box. Where motion is turned down it is simply there.
 */
export function useTyped(text: string, { speedMs = 55, delayMs = 500 } = {}): string {
  const still =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [shown, setShown] = useState(still ? text.length : 0);
  const [caret, setCaret] = useState(true);
  useEffect(() => {
    if (still) return;
    setShown(0);
    let at = 0;
    let timer = setTimeout(function next() {
      at++;
      setShown(at);
      if (at < text.length) timer = setTimeout(next, speedMs + Math.random() * speedMs);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [text, still, speedMs, delayMs]);
  useEffect(() => {
    if (still) return;
    const blink = setInterval(() => setCaret((on) => !on), 530);
    return () => clearInterval(blink);
  }, [still]);
  if (still) return text;
  return text.slice(0, shown) + (caret ? '\u258F' : ' ');
}
