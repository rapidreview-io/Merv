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

/** One commit of a history, as `git log` says it, and the work it came from (code.log). */
export interface CodeLogEntry {
  oid: string;
  parents: string[];
  /** The author date, ISO 8601. */
  date: string;
  subject: string;
  body: string;
  /** The task or experiment whose accepted work this commit is, when Merv knows it. */
  unit?: { id: string; kind: string; title: string };
}
