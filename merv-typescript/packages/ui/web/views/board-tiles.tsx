import { useBoardView } from '../board-app/board-view';
/**
 * A card that opens another board shows that board: a small picture of it laid over the card, panning
 * and zooming with this one, its title beneath. The card stays the shape that is selected and opened.
 */
import { useEffect, useState } from 'react';
import { sceneCoordsToViewportCoords } from '@excalidraw/excalidraw';
import { boardPicture } from './board-picture';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import './board-tiles.css';
import { boardTitles } from './board-titles';

const boardOf = (el: ExcalidrawElement) =>
  !el.isDeleted &&
  el.type === 'rectangle' &&
  typeof el.customData?.target === 'string' &&
  /^board_/.test(el.customData.target)
    ? (el.customData.target as string)
    : undefined;
export function BoardTiles({ api, dark }: { api: ExcalidrawImperativeAPI; dark: boolean }) {
  const { elements, state } = useBoardView(api);
  const cards = elements.filter(boardOf);
  if (!cards.length) return null;
  const titles = boardTitles(elements);
  return (
    <div className="canvas-tiles">
      {cards.map((card) => (
        <Tile
          key={card.id}
          card={card}
          title={titles.get(card.groupIds[0]) ?? ''}
          dark={dark}
          zoom={state.zoom.value}
          at={sceneCoordsToViewportCoords({ sceneX: card.x, sceneY: card.y }, state)}
        />
      ))}
    </div>
  );
}

function Tile({
  card,
  title,
  dark,
  zoom,
  at,
}: {
  card: ExcalidrawElement;
  title: string;
  dark: boolean;
  zoom: number;
  at: { x: number; y: number };
}) {
  const board = boardOf(card)!;
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let live = true;
    setSrc(undefined);
    const lease = boardPicture(board, dark);
    void lease.promise.then((url) => {
      if (live) setSrc(url);
    });
    return () => {
      live = false;
      lease.release();
    };
  }, [board, dark]);
  return (
    <div
      className="canvas-tile"
      style={{
        left: at.x,
        top: at.y,
        width: card.width,
        height: card.height,
        transform: `scale(${zoom})`,
      }}
    >
      {src ? <img src={src} alt="" /> : <span className="canvas-tile-empty" />}
      <span className="canvas-tile-title">{title}</span>
    </div>
  );
}
