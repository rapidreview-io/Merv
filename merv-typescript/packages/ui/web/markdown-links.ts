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
 * which can only stay on this origin. Whitespace and control characters go first,
 * because a browser ignores them inside a scheme and `java\tscript:` must not pass;
 * anything else — javascript:, data:, vbscript:, file: — is refused and its text stays.
 */
export function safeHref(raw: string): { href: string; external: boolean } | null {
  // eslint-disable-next-line no-control-regex
  const href = raw.replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028-\u202e\ufeff]/g, '');
  if (!href) return null;
  // A browser reads a backslash as a slash, so `/\host` is another origin too.
  if (/^[/\\]{2}/.test(href))
    return { href: `https:${href.replaceAll('\\', '/')}`, external: true };
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)?.[1]?.toLowerCase();
  if (scheme === undefined) return { href, external: false };
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto'
    ? { href, external: true }
    : null;
}
