import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_TRANSCRIPT_BYTES } from '@merv/contracts';
import type { SessionTranscriptDeclaration } from '@merv/sessions/types';
import type { Harness } from './harness/index.js';

/** What Sessions is told of the file: all it believes of it. */
export type TranscriptFacts = Omit<SessionTranscriptDeclaration, 'hostRef' | 'deliver'>;

/**
 * A bearer standing alone: Merv's (mi_/mk_/ms_ + 43 base64url, me_/mr_ + 64 hex), Pi's and Nisa's
 * (pir_/piw_/rr_sk_), and common provider keys (sk-…, GitHub ghp_… and github_pat_…, AWS AKIA…);
 * not inside a longer identifier (mcp__merv__…, max_…), but also right after a JSON escape such as
 * \n or \u0022.
 */
export const bearer =
  /(?:(?<![A-Za-z0-9_-])|(?<=\\(?:[nrtbf]|u[0-9a-fA-F]{4})))(?:m[iks]_[A-Za-z0-9_-]{43}|m[er]_[0-9a-f]{64}|(?:pi[rw]|rr_sk)_[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|sbxt_[A-Za-z0-9_-]{32,}|hf_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})(?![A-Za-z0-9_-])/;
/** Bearers and each exact secret of at least 16 characters, as one global pattern. */
export const blankPattern = (secrets: string[]) =>
  new RegExp(
    [
      bearer.source,
      ...secrets
        .filter((secret) => secret.length >= 16)
        .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    ].join('|'),
    'g',
  );
/** Covers the longest private HF token (4096 bytes) as well as provider credentials. */
const CARRY = 4096;
/** Enough of what was already written for the bearer's lookbehind (`\u0022` is six). */
const CONTEXT = 16;
/** Room kept for the marker line, which is under 80 bytes. */
const MARKER = 128;

/**
 * The launch's stdout as kept: the whole log up to `cap`, else its first min(16 MiB, cap/4) bytes
 * and its last bytes, each cut at a line end, around one marker line; the harness's partial-message
 * lines dropped where a whole message follows them, and bearers and each exact secret (≥ 16 chars) blanked. Undefined when nothing was printed. Never follows a link or waits
 * on a FIFO; reads at most `cap` bytes into one buffer, which the blanking compacts in place
 * (every replacement is shorter than what it replaces). Deterministic for one log. Synchronous:
 * a typical log is about 100 KB; one near the cap costs the tick a second or so.
 */
export function readTranscript(
  runDirectory: string,
  secrets: string[],
  harness: Harness | undefined,
  cap = MAX_TRANSCRIPT_BYTES,
  chunk = 4 << 20,
) {
  let fd: number;
  try {
    fd = openSync(
      join(runDirectory, 'stdout.log'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return undefined;
    const logBytes = stat.size,
      truncated = logBytes > cap;
    const out = Buffer.allocUnsafe(Math.min(logBytes, cap));
    const fill = (offset: number, length: number, position: number) => {
      let read = 0;
      for (let n = 1; n > 0 && read < length; read += n)
        n = readSync(fd, out, offset + read, length - read, position + read);
      return read;
    };
    // [start, end) of `out` to keep, and where the log's bytes between them were left out.
    const segments: [number, number][] = [];
    let omitted = 0;
    if (!truncated) segments.push([0, fill(0, logBytes, 0)]);
    else {
      const head = Math.min(16 << 20, Math.floor(cap / 4)),
        tail = Math.max(0, cap - head - MARKER);
      const got = fill(0, head, 0),
        headEnd = got && out.lastIndexOf(0x0a, got - 1) + 1;
      const end = cap - tail + fill(cap - tail, tail, logBytes - tail),
        first = out.indexOf(0x0a, cap - tail);
      const from = first < 0 || first >= end ? end : first + 1;
      segments.push([0, headEnd], [from, end]);
      omitted = logBytes - headEnd - (end - from);
    }
    if (harness) dropDeltas(out, segments, harness);
    const blank = blankPattern(secrets.map((secret) => Buffer.from(secret).toString('latin1')));
    const carry = Math.max(CARRY, ...secrets.map((secret) => Buffer.byteLength(secret)));
    let length = 0;
    for (const [index, [start, end]] of segments.entries()) {
      if (index > 0) length += out.write(marker(omitted), length, 'latin1');
      // Latin-1 maps each byte to one character, so multibyte UTF-8 passes through untouched.
      let context = '',
        pending = '';
      for (let position = start; position < end;) {
        const next = Math.min(end, position + chunk);
        const text = context + pending + out.toString('latin1', position, next);
        position = next;
        // A match starting before `safe` has its whole token and the character after it here.
        const safe = position === end ? text.length : Math.max(context.length, text.length - carry);
        let kept = '',
          last = context.length;
        blank.lastIndex = context.length;
        for (let match; (match = blank.exec(text)) && match.index < safe;) {
          kept += text.slice(last, match.index) + '[REDACTED]';
          last = match.index + match[0].length;
        }
        const cut = Math.max(safe, last);
        kept += text.slice(last, cut);
        length += out.write(kept, length, 'latin1');
        context = text.slice(Math.max(0, cut - CONTEXT), cut);
        pending = text.slice(cut);
      }
    }
    if (length === 0) return undefined; // it shrank to nothing while being read
    const bytes = out.subarray(0, length);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      bytes,
      facts: { sha256, size: length, logBytes, truncated } satisfies TranscriptFacts,
    };
  } finally {
    closeSync(fd);
  }
}
const marker = (omittedBytes: number) =>
  `${JSON.stringify({ type: 'merv.transcript.truncated', omittedBytes })}\n`;
/**
 * Moves each segment's lines to its start, but the partial-message lines that a later whole
 * message repeats (the live view read them from stdout.log); those after the last whole message,
 * as of a run stopped mid-message, are kept.
 */
function dropDeltas(out: Buffer, segments: [number, number][], harness: Harness) {
  let last = -1;
  for (const find of [true, false])
    for (const segment of segments) {
      let to = segment[0];
      for (let line = segment[0], stop; line < segment[1]; line = stop) {
        const newline = out.indexOf(0x0a, line);
        stop = newline < 0 || newline >= segment[1] ? segment[1] : newline + 1;
        const kind = harness.line(out.toString('latin1', line, Math.min(stop, line + 32)));
        if (find) last = kind === 'whole' ? line : last;
        else if (kind !== 'delta' || line > last) to += out.copy(out, to, line, stop);
      }
      if (!find) segment[1] = to;
    }
}
