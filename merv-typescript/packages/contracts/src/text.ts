/** Text with something to read: not only whitespace and invisible format characters. */
export const visible = (text: string) => /[^\s\p{Cf}]/u.test(text);
/** A name nobody wrote is not one: an identifier (a UUID, a minted id's hex, a sign-in key)
 *  names nobody. */
export const personName = (name: string | undefined) =>
  name && !/[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{16,}|\|/.test(name) ? name : undefined;
/** At most `max` UTF-16 units, never ending in half a surrogate pair. */
export const clip = (text: string, max: number) =>
  text.length > max ? text.slice(0, max).replace(/\p{Surrogate}$/u, '') : text;
/** At most `max` UTF-16 units, the last of them '…' when the text was cut. */
export const ellipsis = (text: string, max: number) =>
  text.length > max ? `${clip(text, max - 1).trimEnd()}…` : text;
/** Text as HTML character data or a quoted attribute value: never markup. */
export const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
/** The first clause of a recorded sentence, in its own words; null where nothing was written. */
export function firstSentence(text: string | null | undefined, limit = 140): string | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  const stop = trimmed.search(/[.!?](\s|$)|\n/);
  const first = (stop >= 0 ? trimmed.slice(0, stop + 1) : trimmed).trim();
  return ellipsis(first, limit);
}
/**
 * Text a remote service sent, at most `max` UTF-16 units of it, without control characters
 * other than line breaks and tabs or half a surrogate pair; anything but a string is ''.
 */
export const cleanText = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? clip(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\p{Surrogate}/gu, ''), max)
    : '';
/**
 * An artifact's title as a context item's title, or its ID when the title is only line breaks and
 * white space: the builder folds an item title onto one line and refuses one left empty.
 */
export const itemTitle = ({ id, title }: { id: string; title: string }) =>
  /[^\s\u0085]/.test(title) ? title : id;
