/** Words typed to a drawer, as the voice hears of them: no imports, so anything that sends may say so. */
/** The page's own event for words a person typed to a drawer, whichever composer they typed in. */
export const TYPED = 'merv:typed';
/** Words are on their way to a drawer by hand: the voice, if it is telling something, is quieted. */
export function sentByHand() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(TYPED));
}
