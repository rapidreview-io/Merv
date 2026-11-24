/** Files sent to Merv: each kept in the project as an artifact, and named in the message by one line Merv reads
 *  (`[Attached name (type): art_…]`), so every path a message travels (the stream, the Mac's pane, a retry) carries it. */
import { useEffect, useRef, useState } from 'react';

/** Pictures Merv can see, PDFs and plain text it can read. */
export const MERV_FILE_TYPES =
  'image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/json,.md,.markdown,.csv,.json,.txt';
const MERV_FILE_MB = 20;
const MERV_FILES_MOST = 8;
const READABLE = /^(image\/(png|jpeg|webp)|application\/(pdf|json)|text\/[\w.+-]+)$/;
const ENDINGS: [RegExp, string][] = [
  [/\.(md|markdown)$/i, 'text/markdown'],
  [/\.csv$/i, 'text/csv'],
  [/\.json$/i, 'application/json'],
  [/\.txt$/i, 'text/plain'],
];
const mediaTypeOf = (file: File) =>
  file.type.toLowerCase().split(';')[0]!.trim() ||
  ENDINGS.find(([ending]) => ending.test(file.name))?.[1] ||
  '';

interface MervFile {
  key: string;
  file: File;
  name: string;
  mediaType: string;
  state: 'uploading' | 'ready' | 'failed';
  note?: string;
  refused?: boolean;
  id?: string;
  preview?: string;
}
/** Keeps a file in the project, answering its artifact id; throws with a plain reason. */
type StoreFile = (file: File, mediaType: string) => Promise<string>;

const refusal = (file: File, mediaType: string) =>
  !READABLE.test(mediaType)
    ? 'Merv takes pictures (PNG, JPEG, WebP), PDFs and text files'
    : !file.size
      ? 'This file is empty'
      : file.size > MERV_FILE_MB * 1024 * 1024
        ? `Up to ${MERV_FILE_MB} MB a file`
        : '';

export function useMervFiles(store: StoreFile) {
  const [files, setFiles] = useState<MervFile[]>([]);
  const live = useRef(files);
  live.current = files;
  const change = (key: string, next: Partial<MervFile>) =>
    setFiles((files) => files.map((one) => (one.key === key ? { ...one, ...next } : one)));
  const upload = (one: MervFile) => {
    change(one.key, { state: 'uploading', note: undefined });
    store(one.file, one.mediaType).then(
      (id) => change(one.key, { state: 'ready', id }),
      (error: unknown) =>
        change(one.key, {
          state: 'failed',
          note:
            error instanceof Error && error.message
              ? `Upload failed: ${error.message}`
              : 'Upload failed',
        }),
    );
  };
  useEffect(
    () => () => live.current.forEach((one) => one.preview && URL.revokeObjectURL(one.preview)),
    [],
  );
  return {
    files,
    /** Each file chosen becomes a chip at once: uploading, or refused with why. */
    add(chosen: File[]) {
      const room = MERV_FILES_MOST - live.current.length;
      const added = chosen.slice(0, Math.max(0, room)).map((file): MervFile => {
        const mediaType = mediaTypeOf(file),
          note = refusal(file, mediaType);
        return {
          key: crypto.randomUUID(),
          file,
          name: file.name || 'File',
          mediaType,
          state: note ? 'failed' : 'uploading',
          ...(note && { note, refused: true }),
          ...(!note && mediaType.startsWith('image/') && { preview: URL.createObjectURL(file) }),
        };
      });
      if (chosen.length > added.length)
        added.push(
          ...chosen.slice(added.length, added.length + 1).map((file): MervFile => ({
            key: crypto.randomUUID(),
            file,
            name: file.name || 'File',
            mediaType: '',
            state: 'failed',
            refused: true,
            note: `Up to ${MERV_FILES_MOST} files a message`,
          })),
        );
      setFiles((files) => [...files, ...added]);
      for (const one of added) if (one.state === 'uploading') upload(one);
    },
    retry: (key: string) => {
      const one = live.current.find((item) => item.key === key);
      if (one?.state === 'failed' && !one.refused) upload(one);
    },
    remove: (key: string) =>
      setFiles((files) =>
        files.filter((one) => {
          if (one.key === key && one.preview) URL.revokeObjectURL(one.preview);
          return one.key !== key;
        }),
      ),
    clear: () => {
      live.current.forEach((one) => one.preview && URL.revokeObjectURL(one.preview));
      setFiles([]);
    },
    /** Sending waits until every chip is uploaded, or removed. */
    settled: files.every((one) => one.state === 'ready'),
    /** What is sent: the words, then a line for each file. */
    text: (words: string) =>
      [
        words.trim(),
        files
          .filter((one) => one.id)
          .map((one) => attachedLine(one.name, one.mediaType, one.id!))
          .join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n'),
  };
}

const attachedLine = (name: string, mediaType: string, id: string) =>
  `[Attached ${name.replace(/[\r\n]+/g, ' ').trim() || 'File'} (${mediaType}): ${id}]`;
const LINE = /^\[Attached (.+) \(([a-z0-9.+-]+\/[a-z0-9.+-]+)\): (art_[A-Za-z0-9_-]+)\]$/gm;
/** A sent message as the person wrote it, and the files that went with it. */
export function splitAttached(text: string): {
  text: string;
  files: { name: string; mediaType: string; id: string }[];
} {
  const files = [...text.matchAll(LINE)].map(([, name, mediaType, id]) => ({
    name: name!,
    mediaType: mediaType!,
    id: id!,
  }));
  return files.length ? { text: text.replace(LINE, '').trim(), files } : { text, files };
}

/** Above the words being written: each file, its state, and × to remove it; a failed upload also offers Retry. */
export function MervFileChips({
  files,
  remove,
  retry,
}: Pick<ReturnType<typeof useMervFiles>, 'files' | 'remove' | 'retry'>) {
  if (!files.length) return null;
  return (
    <div className="composer-pictures merv-files">
      {files.map((one) => (
        <span key={one.key} className={`merv-file is-${one.state}`} title={one.note ?? one.name}>
          {one.preview ? <img src={one.preview} alt="" /> : null}
          <span className="merv-file-words">
            <span className="merv-file-name">{one.name}</span>
            {one.state === 'uploading' && (
              <span className="merv-file-note" role="status">
                Uploading…
              </span>
            )}
            {one.note && (
              <span className="merv-file-note" role="alert">
                {one.note}
              </span>
            )}
          </span>
          {one.state === 'failed' && !one.refused && (
            <button type="button" className="merv-file-act" onClick={() => retry(one.key)}>
              Retry
            </button>
          )}
          <button
            type="button"
            className="merv-file-act"
            aria-label={`Remove ${one.name}`}
            onClick={() => remove(one.key)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

/** A sent message's files, under its words. */
export function SentFiles({ files }: { files: ReturnType<typeof splitAttached>['files'] }) {
  return (
    <span className="sent-files">
      {files.map((one) => (
        <span key={one.id} className="file-chip" title={one.name}>
          {one.name}
        </span>
      ))}
    </span>
  );
}
