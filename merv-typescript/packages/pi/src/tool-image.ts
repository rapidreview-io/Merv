/** A look's image (any tool's result of this shape, by whatever name it was called) bypasses text
 *  budgets; every other result keeps ordinary JSON. */
export function screenImage(
  result: unknown,
): {
  images: { data: string; mimeType: 'image/jpeg' }[];
  metadata: Record<string, unknown>;
} | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const { image, images, ...metadata } = result as Record<string, unknown>;
  const all = image ? [image] : images;
  if (!Array.isArray(all) || !all.length || all.length > 4) return null;
  for (const one of all as { data?: unknown; mimeType?: unknown }[])
    if (
      !one ||
      one.mimeType !== 'image/jpeg' ||
      typeof one.data !== 'string' ||
      one.data.length > 700000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(one.data)
    )
      return null;
  return { images: all as { data: string; mimeType: 'image/jpeg' }[], metadata };
}

/** Keep the latest two views, all of the latest result (a PDF's pages come several at once), plus
 * the current reference's overview and latest detail.
 * Four bounded images fit below the relay byte limit, while crops cannot erase the source
 * composition just before the agent compares it with its drawing. */
export function recentImages<T extends { role: string }>(messages: T[]): T[] {
  type Part = { type?: string; text?: string };
  const images: { part: Part; reference?: string; result: T }[] = [];
  for (const message of messages) {
    const value = message as T & { content?: Part[] };
    if (message.role !== 'toolResult' || !Array.isArray(value.content)) continue;
    let reference: string | undefined;
    try {
      const metadata = JSON.parse(value.content.find((p) => p.type === 'text')?.text ?? '{}');
      if (
        typeof metadata.page === 'string' &&
        /^\/ui\/artifacts\/art_[A-Za-z0-9_-]+$/.test(metadata.page)
      )
        reference = metadata.page;
    } catch {
      /* Non-JSON tool text has no reference identity. */
    }
    for (const part of value.content)
      if (part.type === 'image') images.push({ part, reference, result: message });
  }
  const latest = images.at(-1)?.result;
  const keep = new Set(
    images
      .filter((image, at) => at >= images.length - 2 || image.result === latest)
      .map(({ part }) => part),
  );
  const reference = images.findLast((image) => image.reference)?.reference;
  if (reference) {
    keep.add(images.find((image) => image.reference === reference)!.part);
    keep.add(images.findLast((image) => image.reference === reference)!.part);
  }
  return messages.map((message) => {
    const value = message as T & { content?: Part[] };
    if (message.role !== 'toolResult' || !Array.isArray(value.content)) return message;
    return {
      ...message,
      content: value.content.map((part) =>
        part.type === 'image' && !keep.has(part)
          ? {
              type: 'text',
              text: '[Earlier image omitted; use screen.read look for the reference or board.read look for the drawing to inspect it again.]',
            }
          : part,
      ),
    };
  });
}
