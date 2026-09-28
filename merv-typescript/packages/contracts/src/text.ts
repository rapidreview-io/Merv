/** Text with something to read: not only whitespace and invisible format characters. */
export const visible = (text: string) => /[^\s\p{Cf}]/u.test(text);
/** At most `max` UTF-16 units, never ending in half a surrogate pair. */
export const clip = (text: string, max: number) =>
  text.length > max ? text.slice(0, max).replace(/\p{Surrogate}$/u, '') : text;
/**
 * An artifact's title as a context item's title, or its ID when the title is only line breaks and
 * white space: the builder folds an item title onto one line and refuses one left empty.
 */
export const itemTitle = ({ id, title }: { id: string; title: string }) =>
  /[^\s\u0085]/.test(title) ? title : id;
