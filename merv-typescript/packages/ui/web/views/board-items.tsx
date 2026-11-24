/**
 * A task or an experiment placed on the board shows as its card: the shape that stands for it
 * (a link card whose target is the item's id) wears the item's live mark, its name and question
 * or what it found, and its key curve, panning and zooming with the board. The shape stays what
 * is selected and opened; the card only shows it.
 */
import { sceneCoordsToViewportCoords } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { useBoardView } from '../board-app/board-view';
import { ItemCard, useItemMetrics } from '../item-card';
import { itemState, oneLine, stageWord } from '../item-model';
import { useHome } from './map-data';

const itemOf = (el: ExcalidrawElement) =>
  !el.isDeleted &&
  el.type === 'rectangle' &&
  typeof el.customData?.target === 'string' &&
  /^wf_/.test(el.customData.target)
    ? (el.customData.target as string)
    : undefined;

export function BoardItems({ api }: { api: ExcalidrawImperativeAPI }) {
  const { elements, state } = useBoardView(api);
  const cards = elements.filter(itemOf);
  const home = useHome(cards.length ? 10_000 : 600_000);
  const known = new Map<
    string,
    {
      kind: 'task' | 'experiment';
      name: string;
      question: string;
      state: string;
      settled: boolean;
      failed: boolean;
      finding?: string;
      at: string;
    }
  >();
  for (const t of home.data?.tasks ?? [])
    known.set(t.id, {
      kind: 'task',
      name: t.title,
      question: t.goal,
      state: t.workflow.state,
      settled: t.settled,
      failed: t.failed,
      finding: t.failure?.reason,
      at: t.workflow.updatedAt,
    });
  for (const e of home.data?.experiments ?? [])
    known.set(e.id, {
      kind: 'experiment',
      name: e.name,
      question: e.intent,
      state: e.workflow.state,
      settled: e.settled,
      failed: e.failed,
      finding: e.conclusion ?? undefined,
      at: e.workflow.updatedAt,
    });
  const shown = cards.filter((card) => known.has(itemOf(card)!));
  const metrics = useItemMetrics(
    shown.map((card) => itemOf(card)!),
    { live: shown.some((card) => !known.get(itemOf(card)!)!.settled) },
  );
  if (!shown.length) return null;
  const zoom = state.zoom.value;
  return (
    <div className="canvas-items">
      {shown.map((card) => {
        const id = itemOf(card)!;
        const item = known.get(id)!;
        const at = sceneCoordsToViewportCoords({ sceneX: card.x, sceneY: card.y }, state);
        const mark = itemState(item);
        const ended = mark === 'done' || mark === 'failed';
        return (
          <div
            key={card.id}
            className="canvas-item"
            style={{
              left: at.x,
              top: at.y,
              width: Math.max(card.width, 400),
              transform: `scale(${zoom})`,
            }}
          >
            <ItemCard
              name={item.name}
              kind={item.kind}
              state={mark}
              question={oneLine(item.question, 160)}
              finding={ended ? oneLine(item.finding ?? item.question, 160) : undefined}
              verdict={ended ? (mark === 'done' ? 'pass' : 'fail') : undefined}
              metrics={metrics[id]}
              stage={stageWord(item.kind, item.state)}
              at={item.at}
            />
          </div>
        );
      })}
    </div>
  );
}
