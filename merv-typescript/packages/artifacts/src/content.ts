import { isUtf8 } from 'node:buffer';
import {
  check,
  newId,
  now,
  recorded,
  visible,
  MAX_ARTIFACT_BYTES,
  type Artifact,
  type ArtifactContent,
  type ArtifactInput,
  type Caller,
  type State,
  type Transaction,
} from '@merv/contracts';

// Media types are case-insensitive and stored lowercase; parameters are refused.
const MEDIA = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The metadata columns of an artifact row. Every SELECT on artifacts names these, never `*`. */
export const META =
  'id,project_id,created_by,title,media_type,hash,size,created_at,files_json,metadata_json';
export const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);
export const fromRow = (row: any): Artifact => ({
  id: row.id,
  projectId: row.project_id,
  createdBy: row.created_by,
  title: row.title,
  mediaType: row.media_type,
  hash: row.hash,
  size: row.size,
  createdAt: row.created_at,
  ...(row.files_json != null ? { files: json(row.files_json) } : {}),
  ...(row.metadata_json != null ? { metadata: json(row.metadata_json) } : {}),
});

/** Inserts a new artifact row with its bytes (null: they are only in blobs) and session. */
export async function insert(
  state: State,
  tx: Transaction,
  caller: Caller,
  fields: Pick<Artifact, 'title' | 'mediaType' | 'hash' | 'size'>,
  content: Buffer | null,
): Promise<Artifact> {
  const artifact: Artifact = {
    id: newId('art'),
    projectId: caller.projectId,
    createdBy: caller.actorId,
    ...fields,
    createdAt: now(),
  };
  await tx.run(
    `INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at,content,session_id)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    artifact.id,
    artifact.projectId,
    artifact.createdBy,
    artifact.title,
    artifact.mediaType,
    artifact.hash,
    artifact.size,
    artifact.createdAt,
    content,
    caller.session?.id ?? null,
  );
  await recorded(state, tx, caller, 'artifact.created', artifact.id, {
    hash: artifact.hash,
    size: artifact.size,
  });
  return artifact;
}

/** Bytes read back as text. Tool input refuses NUL in text, so bytes carrying it are not text:
 * a text answer has to be one the caller could send back. */
export const isText = (bytes: Buffer) => isUtf8(bytes) && !bytes.includes(0);

/** The title and media type of a new artifact or upload, validated and normalised. */
export function meta(title: unknown, mediaType: unknown) {
  check(
    typeof title === 'string' && title.length <= 300 && visible(title),
    'invalid_artifact',
    'Artifact requires a visible title of at most 300 characters',
  );
  check(
    typeof mediaType === 'string' && mediaType.length <= 150 && MEDIA.test(mediaType.toLowerCase()),
    'invalid_media_type',
    'Invalid media type',
  );
  return { title: title.trim(), mediaType: mediaType.toLowerCase() };
}

/** The bytes of a new inline artifact: 1..MAX_ARTIFACT_BYTES, from utf8 or canonical base64. */
export function decode(input: ArtifactInput): Buffer {
  check(typeof input.content === 'string', 'invalid_artifact', 'Content must be a string');
  check(
    input.encoding === undefined || input.encoding === 'utf8' || input.encoding === 'base64',
    'invalid_encoding',
    'Encoding must be utf8 or base64',
  );
  if (input.encoding === 'base64')
    check(BASE64.test(input.content), 'invalid_encoding', 'Invalid base64 content');
  const bytes = Buffer.from(input.content, input.encoding ?? 'utf8');
  check(
    bytes.length > 0 && bytes.length <= MAX_ARTIFACT_BYTES,
    'artifact_size',
    'Artifact must contain 1–2,000,000 bytes',
  );
  return bytes;
}

/** Refuses a malformed range before any lookup or storage I/O. */
export function span(range: { offset?: unknown; length?: unknown }) {
  check(
    range.offset === undefined || (Number.isSafeInteger(range.offset) && Number(range.offset) >= 0),
    'invalid_range',
    'offset must be a non-negative integer',
  );
  check(
    range.length === undefined || (Number.isSafeInteger(range.length) && Number(range.length) >= 1),
    'invalid_range',
    'length must be a positive integer',
  );
}

/** Bytes as tool text, whole or as a range that never tears a character (see Artifacts.read). */
export function view(
  artifact: Artifact,
  bytes: Buffer,
  range: { offset?: number; length?: number },
): ArtifactContent {
  // Any valid UTF-8 is text, whatever its media type.
  const encoding = isText(bytes) ? 'utf8' : 'base64';
  const content = bytes.toString(encoding);
  if (range.offset === undefined && range.length === undefined)
    return { artifact, content, encoding };
  const total = content.length;
  const start = range.offset ?? 0;
  // Each boundary moves forward to the next whole code point or 4-character base64 group, so
  // pages at offset += length tile exactly and every page stands alone.
  const edge = (index: number) => {
    const at = Math.min(index, total);
    if (encoding === 'base64') return Math.min(total, Math.ceil(at / 4) * 4);
    return at < total && (content.charCodeAt(at) & 0xfc00) === 0xdc00 ? at + 1 : at;
  };
  const from = edge(start);
  const to = range.length === undefined ? total : Math.max(from, edge(start + range.length));
  return { artifact, content: content.slice(from, to), encoding, offset: from, total };
}
