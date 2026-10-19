import fonts from 'virtual:board-fonts';
// Same native family IDs as persisted Excalidraw scenes. Helvetica is a system font.
const families: Record<number, string> = {
  1: 'Virgil',
  2: 'Helvetica',
  3: 'Cascadia',
  5: 'Excalifont',
  6: 'Nunito',
  7: 'Lilita One',
  8: 'Comic Shanns',
  9: 'Liberation Sans',
};
const pending = new Map<string, Promise<void>>();
/** Never populate native text-measurement caches with a fallback font on first load. */
export async function ensureBoardFonts(
  elements: readonly {
    type: string;
    fontFamily?: unknown;
    text?: unknown;
    originalText?: unknown;
  }[],
) {
  const textByFamily = new Map<string, string>();
  let allText = '';
  for (const e of elements) {
    if (e.type !== 'text') continue;
    const text = String(e.originalText ?? e.text ?? '');
    const family = families[Number(e.fontFamily)] ?? 'Excalifont';
    textByFamily.set(family, (textByFamily.get(family) ?? '') + text);
    allText += text;
  }
  // Xiaolai is native's fallback, including Korean and compatibility glyphs. Request
  // only subsets containing actual scene characters, not its entire CJK font set.
  textByFamily.set('Xiaolai', allText);
  const covers = (range: string | undefined, text: string) =>
    !range ||
    range.split(',').some((part) => {
      const [low, high = low] = part.trim().replace(/^U\+/i, '').split('-');
      const start = parseInt(low.replace(/\?/g, '0'), 16);
      const end = parseInt(high.replace(/\?/g, 'F'), 16);
      return [...text].some((char) => {
        const code = char.codePointAt(0)!;
        return code >= start && code <= end;
      });
    });
  await Promise.all(
    fonts
      .filter((f) => textByFamily.has(f.family) && covers(f.range, textByFamily.get(f.family)!))
      .map((f) => {
        let request = pending.get(f.url);
        if (!request) {
          request = (async () => {
            const face = new FontFace(f.family, `url(${JSON.stringify(f.url)})`, {
              ...(f.range ? { unicodeRange: f.range } : {}),
            });
            await face.load();
            document.fonts.add(face);
          })().catch((error) => {
            pending.delete(f.url);
            throw error;
          });
          pending.set(f.url, request);
        }
        return request;
      }),
  );
}
