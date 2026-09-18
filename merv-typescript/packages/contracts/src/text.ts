/** Text with something to read: not only whitespace and invisible format characters. */
export const visible = (text: string) => /[^\s\p{Cf}]/u.test(text);
/** At most `max` UTF-16 units, never ending in half a surrogate pair. */
export const clip = (text: string, max: number) =>
  text.length > max ? text.slice(0, max).replace(/\p{Surrogate}$/u, '') : text;
