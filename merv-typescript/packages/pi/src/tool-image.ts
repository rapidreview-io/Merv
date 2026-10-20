/** A look's image (any tool's result of this shape, by whatever name it was called) bypasses text
 *  budgets; every other result keeps ordinary JSON. */
export function screenImage(
  result: unknown,
): { image: { data: string; mimeType: 'image/jpeg' }; metadata: Record<string, unknown> } | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const { image, ...metadata } = result as Record<string, unknown>;
  if (!image || typeof image !== 'object') return null;
  const value = image as { data?: unknown; mimeType?: unknown };
  if (
    value.mimeType !== 'image/jpeg' ||
    typeof value.data !== 'string' ||
    value.data.length > 700000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)
  )
    return null;
  return { image: { data: value.data, mimeType: 'image/jpeg' }, metadata };
}

/** Keep the latest two views plus the current reference's overview and latest detail.
 * Four bounded images fit below the relay byte limit, while crops cannot erase the source
 * composition just before the agent compares it with its drawing. */
export function recentImages<T extends { role: string }>(messages: T[]): T[] {
  type Part = { type?: string; text?: string };
  const images: { part: Part; reference?: string }[] = [];
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
    for (const part of value.content) if (part.type === 'image') images.push({ part, reference });
  }
  const keep = new Set(images.slice(-2).map(({ part }) => part));
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
