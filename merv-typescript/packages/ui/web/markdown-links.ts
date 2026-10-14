/**
 * What the Markdown parser and the page both need, kept apart from both: the parser reads in a
 * worker, which must not load the page's modules, and the page must not load the parser.
 */

/**
 * Every id this system mints is `newId(prefix)`: a lowercase prefix, an underscore
 * and a UUID's 32 hex digits (`art_…`, `wf_…`, `review_…`, `claim_…`, `exp_sub_…`).
 * The shape is recognised whole, so a prefix a later plugin adds is still shortened
 * rather than printed; what an id names and where it leads is its owner's to say.
 */
const ID = '[a-z][a-z_]{0,30}_[0-9a-f]{32}(?![0-9A-Za-z_])';
const ID_ANYWHERE = new RegExp(`(?<![0-9A-Za-z_])(${ID})`, 'g');
/** A text cut at its ids: even places are the author's words, odd places are ids. */
export const splitIds = (text: string): string[] => text.split(ID_ANYWHERE);

/**
 * The only addresses that become an href: http, https, mailto, and a relative one,
 * which can only stay on this origin. Controls go first because a browser ignores
 * them inside a scheme and `java\tscript:` must not pass. Only surrounding spaces are trimmed;
 * anything else — javascript:, data:, vbscript:, file: — is refused and its text stays.
 */
export function safeHref(raw: string): { href: string; external: boolean } | null {
  const href = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\ufeff]/g, '')
    .trim();
  if (!href) return null;
  // A browser reads a backslash as a slash, so `/\host` is another origin too.
  if (/^[/\\]{2}/.test(href))
    return { href: `https:${href.replaceAll('\\', '/')}`, external: true };
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)?.[1]?.toLowerCase();
  if (scheme === undefined) return { href, external: false };
  if (scheme === 'code-file') return codeFile(href) ? { href, external: false } : null;
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto'
    ? { href, external: true }
    : null;
}

/**
 * A file in the project's code, as a report names it: `code-file:<ref>:<path>`, where ref is a
 * full commit, a work unit id or main, and path is relative to the repository root. The Git page
 * opens it at that ref; a page without one shows the name as text.
 */
export function codeFile(href: string): { ref: string; path: string } | null {
  const match = /^code-file:([^:]+):(.+)$/i.exec(href);
  if (!match) return null;
  const [, ref, path] = match as unknown as [string, string, string];
  const refOk =
    ref === 'main' || /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(ref) || new RegExp(`^${ID}$`).test(ref);
  const pathOk =
    !path.startsWith('/') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..');
  return refOk && pathOk ? { ref, path } : null;
}
