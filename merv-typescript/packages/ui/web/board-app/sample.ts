import { agentsPart, DEMOS } from '@merv/board-app/demos';
import type { BoardSummary } from '@merv/board/models';
import { call, refreshTools } from '../api';

/** The one board everybody starts with: the first demo, as ordinary board content. */
export async function drawSample() {
  const [{ title, calls }] = DEMOS as [(typeof DEMOS)[0]];
  let id: string | undefined;
  for (const ops of calls)
    id = (
      await call<{ board: BoardSummary }>('board.write:draw', {
        ...(id ? { board: id } : { title }),
        ops: agentsPart(ops),
      })
    ).board.id;
  refreshTools('board.read');
  return id!;
}
