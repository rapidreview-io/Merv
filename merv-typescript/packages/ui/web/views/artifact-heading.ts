/** Presentation only: the source and raw view keep the original Markdown bytes. */
export function withoutMatchingHeading(markdown: string, title: string): string {
  const normalize = (value: string) =>
    value
      .normalize('NFKC')
      .replace(/[*`~]/g, '')
      .replace(/[-_]+/g, ' ')
      .trim()
      .toLocaleLowerCase()
      .replace(/\s+/g, ' ');
  const stem = title.replace(/\.(?:md|markdown|mdx)$/i, '');
  const heading =
    /^(?:\uFEFF)?[ \t]*(?:\r?\n[ \t]*)*#{1,6}[ \t]+([^\r\n]*?)(?:[ \t]+#+)?[ \t]*(?:\r?\n|$)/.exec(
      markdown,
    ) ??
    /^(?:\uFEFF)?[ \t]*(?:\r?\n[ \t]*)*([^\r\n]+)\r?\n[ \t]*(?:=+|-+)[ \t]*(?:\r?\n|$)/.exec(
      markdown,
    );
  return heading && [title, stem].some((name) => normalize(name) === normalize(heading[1]!))
    ? markdown.slice(heading[0].length)
    : markdown;
}
