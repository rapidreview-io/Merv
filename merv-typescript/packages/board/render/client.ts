import { exportToBlob, restoreElements, getCommonBounds } from '@excalidraw/excalidraw';
import { stacked } from '@merv/board/models';
const restored = (scene) =>
  restoreElements(stacked(scene.elements), null, {
    refreshDimensions: true,
    repairBindings: true,
  }).filter((e) => !e.isDeleted);
window.sceneBounds = (scene, focus) => {
  const live = restored(scene);
  let selected = live;
  if (focus) {
    const named = live.find((e) => e.id === focus);
    const group =
      named?.groupIds?.[0] ?? (live.some((e) => e.groupIds?.includes(focus)) ? focus : undefined);
    if (!named && !group) return null;
    selected = live.filter(
      (e) =>
        e.id === focus ||
        e.containerId === focus ||
        (named?.type === 'frame' && e.frameId === focus) ||
        (group && e.groupIds?.includes(group)),
    );
  }
  if (!selected.length) return { x: 0, y: 0, width: 400, height: 300 };
  const [x, y, right, bottom] = getCommonBounds(selected);
  return { x, y, width: right - x, height: bottom - y };
};
window.renderViewport = async (scene, area) => {
  // The camera is a frame, which shows no other frame or what another holds: here a frame is drawn
  // as a box with its name over it, and what it holds as loose shapes.
  const elements = restored(scene).flatMap((e) =>
    e.type !== 'frame'
      ? [{ ...e, frameId: null }]
      : restoreElements(
          [
            { ...e, type: 'rectangle', strokeColor: '#adb5bd', strokeWidth: 1, roughness: 0 },
            {
              id: `${e.id}:name`,
              type: 'text',
              x: e.x,
              y: e.y - 22,
              text: e.name ?? 'Frame',
              fontSize: 14,
              strokeColor: '#868e96',
            },
          ],
          null,
          { refreshDimensions: true },
        ),
  );
  const [frame] = restoreElements(
    [
      {
        id: '__merv_camera__',
        type: 'frame',
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
        angle: 0,
        name: null,
      },
    ],
    null,
  );
  const scale = Math.min(
    4,
    1600 / Math.max(area.width, area.height),
    768 / Math.min(area.width, area.height),
  );
  const blob = await exportToBlob({
    elements,
    exportingFrame: frame,
    files: scene.files ?? {},
    appState: { viewBackgroundColor: '#ffffff', exportBackground: true, exportWithDarkMode: false },
    mimeType: 'image/jpeg',
    quality: 0.72,
    getDimensions: (width, height) => ({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      scale,
    }),
  });
  return {
    bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    scale,
    pixels: {
      width: Math.max(1, Math.round(area.width * scale)),
      height: Math.max(1, Math.round(area.height * scale)),
    },
  };
};
