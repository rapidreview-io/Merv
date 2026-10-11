/** A project's code read as files (browse.ts), as the browser reads it too: no server import. */
export interface CodeFolderEntry {
  name: string;
  kind: 'folder' | 'file' | 'link' | 'submodule';
  /** Bytes, for a file. */
  size?: number;
}
export type CodeBrowsed =
  | { kind: 'folder'; commit: string; path: string; entries: CodeFolderEntry[] }
  | {
      kind: 'file';
      commit: string;
      path: string;
      size: number;
      /** The text, when it is text and small enough to show; otherwise why not. */
      text?: string;
      withheld?: 'binary' | 'too_large';
    };
