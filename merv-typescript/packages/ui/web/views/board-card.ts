/** The canvas lends its view preservation to the panel without loading Excalidraw there. */
export interface BoardCard {
  small(on: boolean): void;
}

let lent: BoardCard | undefined,
  small = false;

/** Said by the canvas once it is open; returns how it takes itself back. */
export function lendBoardCard(card: BoardCard) {
  lent = card;
  if (small) card.small(true);
  return () => {
    if (lent !== card) return;
    lent = undefined;
  };
}

/** The board is the small card now, or the window again. A board that opens later is told as it opens. */
export function setBoardSmall(on: boolean) {
  if (small === on) return;
  small = on;
  lent?.small(on);
}
