/**
 * Secret-shaped values out of text, before anything is shown, kept or sent. Copied from Merv's
 * board transcripts (hosted/packages/board/src/transcript.ts), which keep the original.
 */
const count = (tally: Record<string, number>, key: string) => {
  tally[key] = (tally[key] ?? 0) + 1;
};

// Secret-shaped values. Order matters: named blocks and prefixes before the general shapes.
// Bound names so a failed search cannot repeatedly scan the rest of a long line.
const SECRETS: [string, RegExp][] = [
  [
    'private-key',
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  ],
  ['url-password', /\b[a-z][a-z0-9+.-]{0,128}:\/\/[^\s:/@"'\\]+:[^\s/@"'\\]+@/gi],
  ['jwt', /\beyJ[\w-]{8,}\.[\w-]{8,}(\.[\w-]+)?/g],
  [
    'api-key',
    /\b(sk|pk|rk)[-_](?:ant-|live-|test-|proj-|live_|test_)?[\w-]{16,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bgh[pousr]_\w{20,}|\bgithub_pat_\w{20,}|\bglpat-[\w-]{16,}|\bxox[abeoprs]-[\w-]{10,}|\bAIza[\w-]{30,}|\bya29\.[\w-]{20,}|\bnpm_\w{20,}|\bhf_\w{20,}|\bwhsec_\w{16,}|\bSG\.[\w-]{16,}\.[\w-]{16,}|\bmk_\w{16,}|\bcfut_\w{16,}|\bdop_v1_\w{16,}|\bre_[A-Za-z0-9]{16,}\w*/g,
  ],
  ['authorization', /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi],
  // Said in prose, a secret may be several words: all of it goes, to the end of its clause.
  [
    'named-secret',
    /\b((?:password|passphrase|token|api[ _-]?key|secret)\s+is\b\s*)(?!\[redacted)(?:"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[^\s;,"'`](?:[^\r\n;,"'`.]|\.+(?=[^\s.])){0,199})/gi,
  ],
  [
    'named-secret',
    /\b((?:password|passphrase|token|api[ _-]?key|secret)\s*[=:]\s*)(?!\[redacted)(?:"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[^\s,;"'`]+)/gi,
  ],
  [
    'named-secret',
    /((?:pass(?:word|wd|phrase)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credentials?|authorization|cookie|session[-_]?key)[\w-]{0,128}\\*["']?\s*(?:[:=]|=>)\s*(\\*["']))(?!\[redacted)(?:(?!\2)[^\n]){1,300}?(?=\2)/gi,
  ],
  [
    'named-secret',
    /((?:pass(?:word|wd|phrase)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credentials?|authorization|cookie|session[-_]?key)[\w-]{0,128}\\*["']?\s*(?:[:=]|=>)\s*(?:\\*["'])?)(?!\[redacted|\$\{?|<|process\.|env\.|true\b|false\b|null\b|undefined\b)[^\s"'\\,;)}\]]{6,}/gi,
  ],
  ['email', /\b[\w.+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g],
];
/** A long run that reads like a key: git's 40-character hashes and plain words are spared. */
const LONG = /(?<![\w/+-])(?:[A-Fa-f0-9]{48,}|[A-Za-z0-9_+=-]{40,})(?![\w/+-])/g;
const keyLike = (run: string) =>
  (/^[A-Fa-f0-9]+$/.test(run) && run.length >= 48) ||
  (/\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run));

/** The text with its secret-shaped values replaced, each counted by its kind. */
export const redact = (text: string, tally: Record<string, number> = {}): string => {
  let out = text;
  for (const [kind, pattern] of SECRETS)
    out = out.replace(pattern, (match, keep) => {
      count(tally, kind);
      return `${kind === 'named-secret' ? keep : ''}[redacted:${kind}]`;
    });
  return out.replace(LONG, (run) => {
    if (!keyLike(run)) return run;
    count(tally, 'long-token');
    return '[redacted:long-token]';
  });
};
