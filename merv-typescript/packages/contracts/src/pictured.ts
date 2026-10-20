/** A look (a board's, an image's, the screen's) as an agent is shown it: its image as an image, the
 *  rest as text. Its own module, so the hosted worker's bundle never carries it. */
export const pictured = (value: unknown) => {
  const { image, ...metadata } = value as { image?: { data: string; mimeType: string } };
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(metadata) },
      ...(image ? [{ type: 'image' as const, ...image }] : []),
    ],
  };
};
