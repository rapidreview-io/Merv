/** Only native screen.look and board.look images bypass text budgets; other tools keep ordinary JSON. */
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

/** Bound replay bytes while keeping the two latest views available for visual comparison. */
export function recentImages<T extends { role: string }>(messages: T[]): T[] {
  let kept = 0;
  return [...messages]
    .reverse()
    .map((message) => {
      const value = message as T & { content?: { type?: string }[] };
      if (message.role !== 'toolResult' || !Array.isArray(value.content)) return message;
      return {
        ...message,
        content: value.content.map((part) =>
          part.type === 'image' && ++kept > 2
            ? {
                type: 'text',
                text: '[Earlier board image omitted; use board.look to inspect it again.]',
              }
            : part,
        ),
      };
    })
    .reverse();
}
