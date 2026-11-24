import {
  restoreElements,
  getCommonBounds,
  convertToExcalidrawElements,
} from '@excalidraw/excalidraw';
import { exportBoardSnapshot } from '../../ui/web/views/board-export';
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
/**
 * A frame's name, written just over its box as Excalidraw itself writes frame titles: Helvetica at
 * 14, a quiet grey, its baseline 3 units above the frame. Excalidraw measures the text here, so the
 * label has a size: a text element left at width 0 and height 0 is dropped as invisibly small by the
 * restore that exportToBlob runs on every element, which is how frame titles went missing before.
 */
const frameLabel = (frame) => {
  const [label] = convertToExcalidrawElements(
    [
      {
        id: `${frame.id}:name`,
        type: 'text',
        x: frame.x,
        y: frame.y,
        text: frame.name ?? 'Frame',
        fontSize: 14,
        fontFamily: 2,
        strokeColor: '#868e96',
      },
    ],
    { regenerateIds: false },
  );
  return { ...label, y: frame.y - label.height - 3 };
};
window.renderViewport = async (scene, area, output = { mimeType: 'image/jpeg', scale: 1 }) => {
  // The camera is a frame, which shows no other frame or what another holds: here a frame is drawn
  // as a box with its name over it, and what it holds as loose shapes.
  const elements = restored(scene).flatMap((e) =>
    e.type !== 'frame'
      ? [{ ...e, frameId: null }]
      : [
          { ...e, type: 'rectangle', strokeColor: '#adb5bd', strokeWidth: 1, roughness: 0 },
          frameLabel(e),
        ],
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
  const scale =
    (output.scale ?? 1) *
    Math.min(4, 1600 / Math.max(area.width, area.height), 768 / Math.min(area.width, area.height));
  const blob = await exportBoardSnapshot(
    {
      elements,
      exportingFrame: frame,
      files: scene.files ?? {},
      appState: {
        viewBackgroundColor: output.paper ?? '#ffffff',
        exportBackground: true,
        exportWithDarkMode: output.theme === 'dark',
      },
      mimeType: output.mimeType ?? 'image/jpeg',
      quality: 0.72,
      getDimensions: (width, height) => ({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        scale,
      }),
    },
    scale,
  );
  return {
    bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    scale,
    pixels: {
      width: Math.max(1, Math.round(area.width * scale)),
      height: Math.max(1, Math.round(area.height * scale)),
    },
  };
};
