/** CSS unicode-range coverage, shared by the page and offline board exports. */
export function fontRangeMatcher(text: string): (range?: string) => boolean {
  // Native wrapping normalizes to NFC; keep both the supplied and composed characters.
  const unique = new Set<number>();
  for (const char of text) unique.add(char.codePointAt(0)!);
  for (const char of text.normalize('NFC')) unique.add(char.codePointAt(0)!);
  const points = [...unique];
  return (range) =>
    !range ||
    range.split(',').some((part) => {
      const match = /^U\+([\dA-F?]{1,6})(?:-([\dA-F]{1,6}))?$/i.exec(part.trim());
      // An unfamiliar declaration cannot safely prove that a face is unnecessary.
      if (!match) return true;
      const low = parseInt(match[1]!.replace(/\?/g, '0'), 16);
      const high = parseInt((match[2] ?? match[1]!).replace(/\?/g, 'F'), 16);
      return points.some((code) => code >= low && code <= high);
    });
}
