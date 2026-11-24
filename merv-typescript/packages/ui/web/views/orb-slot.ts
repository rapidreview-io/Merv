/** Where Merv's orb sits in Excalidraw's toolbar, its middle; laid out by board-app.css. Kept apart
 *  from board-canvas.tsx so what only needs the slot never loads the editor and its stylesheet. */
import { useSyncExternalStore } from 'react';

const orbSlot = { at: null as HTMLElement | null, heard: new Set<() => void>() };
export const holdSlot = (at: HTMLElement | null) => {
  if (orbSlot.at === at) return;
  orbSlot.at = at;
  orbSlot.heard.forEach((heard) => heard());
};
export const useOrbSlot = () =>
  useSyncExternalStore(
    (heard) => (orbSlot.heard.add(heard), () => void orbSlot.heard.delete(heard)),
    () => orbSlot.at,
  );
