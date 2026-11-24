import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

/** Match the first title for each card group, including ungrouped cards. */
export function boardTitles(
  elements: readonly ExcalidrawElement[],
): Map<string | undefined, string> {
  const titles = new Map<string | undefined, string>();
  for (const element of elements) {
    if (element.type !== 'text' || !element.customData?.title) continue;
    const group = element.groupIds[0];
    if (!titles.has(group)) titles.set(group, element.originalText ?? '');
  }
  return titles;
}
