import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
} from '@excalidraw/excalidraw/element/types';
import { exportToBlob } from '@excalidraw/excalidraw';

/** Excalidraw's live dark canvas uses an outer CSS filter and compensates raster images
 * inside it. Its export path instead resets the image filter, producing different pixels.
 * Reproduce that live raster treatment on temporary copies, then let Excalidraw export
 * the paper and vectors in dark mode exactly once. Never rewrite the board's image files.
 */
export async function exportBoardSnapshot(
  options: Parameters<typeof exportToBlob>[0],
  rasterScale?: number,
) {
  if (!options.appState?.exportWithDarkMode || !options.files) return exportToBlob(options);
  const files = { ...options.files };
  const images: readonly ExcalidrawImageElement[] = options.elements.filter(
    (el: ExcalidrawElement) => el.type === 'image',
  );
  const used = new Set<string>(images.flatMap((el) => (el.fileId ? [el.fileId] : [])));
  // Decoding all full-size rasters together exhausts Chromium's decode resources on large
  // boards. Keep a small batch in flight, releasing temporary pixels after each conversion.
  const ids = [...used];
  for (let at = 0; at < ids.length; at += 4)
    await Promise.all(
      ids.slice(at, at + 4).map(async (id) => {
        const file = files[id];
        // SVGs follow Excalidraw's vector treatment; only raster images are compensated live.
        if (!file || file.mimeType === 'image/svg+xml') return;
        const image = new Image();
        const inner = document.createElement('canvas');
        const outer = document.createElement('canvas');
        try {
          image.src = file.dataURL;
          await image.decode();
          // An overview may show a 1600px photo at only 30px. Filter only the pixels the
          // snapshot needs. Crops retain source dimensions because their coordinates use them.
          const shapes = images.filter((el) => el.fileId === id);
          const ratio =
            rasterScale !== undefined && shapes.every((el) => !el.crop)
              ? Math.min(
                  1,
                  Math.max(
                    ...shapes.map(
                      (el) =>
                        Math.max(el.width / image.naturalWidth, el.height / image.naturalHeight) *
                        rasterScale,
                    ),
                  ),
                )
              : 1;
          inner.width = Math.max(1, Math.ceil(image.naturalWidth * ratio));
          inner.height = Math.max(1, Math.ceil(image.naturalHeight * ratio));
          const context = inner.getContext('2d')!;
          context.filter = 'invert(100%) hue-rotate(180deg) saturate(1.25)';
          context.drawImage(image, 0, 0, inner.width, inner.height);
          outer.width = inner.width;
          outer.height = inner.height;
          const display = outer.getContext('2d')!;
          display.filter = 'invert(93%) hue-rotate(180deg)';
          display.drawImage(inner, 0, 0);
          files[id] = {
            ...file,
            mimeType: 'image/png',
            dataURL: outer.toDataURL() as typeof file.dataURL,
          };
        } catch {
          // A missing file uses Excalidraw's quiet image placeholder. Keep the shape and the
          // original file untouched, and continue exporting the rest of the board.
          delete files[id];
        } finally {
          inner.width = inner.height = outer.width = outer.height = 0;
          image.src = '';
        }
      }),
    );
  return exportToBlob({ ...options, files });
}
