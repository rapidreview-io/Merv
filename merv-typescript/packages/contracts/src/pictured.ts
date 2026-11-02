/** A look (a board's, an image's, the screen's) as an agent is shown it: its image as an image, the
 *  rest as text. Its own module, so the hosted worker's bundle never carries it. */
export const pictured = (value: unknown) => {
  type Image = { data: string; mimeType: string };
  const { image, images, ...metadata } = value as { image?: Image; images?: Image[] };
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(metadata) },
      ...[...(image ? [image] : []), ...(images ?? [])].map((one) => ({
        type: 'image' as const,
        ...one,
      })),
    ],
  };
};
