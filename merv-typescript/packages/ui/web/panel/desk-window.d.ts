/**
 * The bridge Merv.app's window gives its panel (`window.desk`). Merv never sets it: the parts that
 * read it (the hand-off card's "Ask Merv again", panel size) find it absent and draw nothing of it.
 * Merv.app's own transport to its desk (127.0.0.1) was left out of the move.
 */
/** Merv.app's build as the app tells it (apps/desktop/src/updates.ts). */
interface UpdateState {
  version: string;
  channel: 'stable' | 'nightly';
  built: 'stable' | 'nightly';
  /** When the build was made, and whether on this Mac rather than published. The commit is not here. */
  builtAt?: string;
  local?: boolean;
  available?: {
    version: string;
    date: string;
    ready?: boolean;
    notes?: string[];
    required?: boolean;
    background?: boolean;
  };
  updating?: boolean;
  checked?: string;
  failed?: string;
}
/** The panel as Merv.app holds it. In the chat's stage the board lies over this page at `card`, and the column under it is `left` wide. */
interface PanelState {
  shown: boolean;
  compact: boolean;
  stage?: 'board' | 'chat';
  left?: number;
  card?: { x: number; y: number; width: number; height: number };
}

declare global {
  interface Window {
    desk?: {
      port: number;
      token: string;
      panelShown?: boolean;
      onPanel?(heard: (state: PanelState) => void): () => void;
      /** Make the board or the chat the big one; hide or show the small column beside the chat. */
      stage?(next: 'board' | 'chat'): void;
      side?(show?: boolean): void;
      showPanel?(show?: boolean): void;
      resizePanel?(width?: number, save?: boolean): void;
      panes?(
        rects: { x: number; y: number; width: number; height: number; browser: boolean }[],
        hidden: boolean,
      ): void;
      paneShare?(): Promise<number>;
      savePaneShare?(share: number): void;
      onPane?(heard: (action: string) => void): () => void;
      openWeb?(where?: string): void;
      focusWeb?(): void;
      pickFolder?(): Promise<string | null>;
      /** Ask Merv again for a hand-off's task prompt, through the board beside the panel. */
      handoffRetry?(id: string): Promise<boolean>;
      onNew?(start: () => void): () => void;
      onOpen?(open: (thread: string, done?: boolean) => void): void;
      updates?: {
        get(): Promise<UpdateState>;
        on(heard: (state: UpdateState) => void): () => void;
        check(): Promise<UpdateState>;
        follow(channel: 'stable' | 'nightly'): Promise<UpdateState>;
        install(): Promise<UpdateState>;
        /** The width the line beside the closed island needs, 0 for none. */ room?(
          width: number,
        ): void;
        /** Copy the build's details, commit included, to the clipboard. */ copy?(): Promise<boolean>;
      };
      demo?: { send(message: unknown): void; on(heard: (message: unknown) => void): () => void };
      merv?: {
        last(): Promise<unknown>;
        onChat(heard: (chat: unknown) => void): () => void;
        say(text: string): void;
        file?(file: {
          name: string;
          type: string;
          data: Uint8Array;
        }): Promise<{ id?: string; error?: string }>;
        typed?(): void;
        onOpen(open: () => void): () => void;
      };
    };
  }
}
export {};
