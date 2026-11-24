import { boardAppearance } from '@merv/protocol/looks';
import type { Caller } from '@merv/contracts';
import type { Region, View } from '@merv/contracts/board-view';
import type { Board, BoardElement, BoardScene } from './types.js';
import { BoardRenderer, boardImages, type Rendered } from './renderer.js';

export interface RenderOptions {
  current?: Region;
  view?: View;
  region?: Region;
  focus?: string;
  elements?: BoardElement[];
  maxBytes?: number;
  paper?: string;
  appearance?: 'light' | 'dark';
}

/** One renderer for service calls and agent tools; a captured scene keeps a frozen view stable. */
export class BoardRendering {
  private readonly renderer = new BoardRenderer();
  // Display preferences are per person and board, never authored scene data. Keep the last
  // known appearance while a task is being discussed, even if its page goes into the background.
  private readonly appearances = new Map<string, 'light' | 'dark'>();
  private key(caller: Caller, board: string) {
    return JSON.stringify([caller.projectId, caller.actorId, board]);
  }
  display(caller: Caller, board: string, appearance: 'light' | 'dark') {
    const key = this.key(caller, board);
    this.appearances.delete(key);
    this.appearances.set(key, appearance);
    if (this.appearances.size > 512) this.appearances.delete(this.appearances.keys().next().value!);
  }
  constructor(private readonly board: Pick<Board, 'scene' | 'image'>) {}
  async render<T extends RenderOptions>(
    caller: Caller,
    board: string | BoardScene,
    input?: T,
  ): Promise<Rendered<T extends { maxBytes: number } ? 'image/png' : 'image/jpeg'>> {
    const options: RenderOptions = input ?? {};
    const scene = typeof board === 'string' ? await this.board.scene(caller, board) : board;
    const elements = options.elements ?? scene.elements;
    const seen = this.appearances.get(this.key(caller, scene.board.id));
    const display = options.appearance ?? seen;
    const paper = options.paper ?? scene.board.paper;
    const appearance = boardAppearance(paper, display ?? 'light');
    return this.renderer.render(
      elements,
      options.current,
      options.region ? { action: 'region', ...options.region } : options.view,
      options.focus,
      boardImages(this.board, caller, elements),
      options.maxBytes as number,
      appearance.viewBackgroundColor,
      appearance.theme,
    ) as Promise<Rendered<T extends { maxBytes: number } ? 'image/png' : 'image/jpeg'>>;
  }
  close() {
    this.appearances.clear();
    return this.renderer.close();
  }
}
