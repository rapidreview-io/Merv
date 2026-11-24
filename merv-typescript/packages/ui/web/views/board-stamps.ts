/** A shape's saved identity includes the nonce that settles equal-version edits. */
export type ShapeStamp = Readonly<{ version: number; versionNonce: number }>;
export const stampOf = ({ version, versionNonce }: ShapeStamp): ShapeStamp =>
  Object.freeze({ version, versionNonce });
export const sameStamp = (known: ShapeStamp | undefined, shape: ShapeStamp): boolean =>
  known?.version === shape.version && known.versionNonce === shape.versionNonce;

/** The shapes Board keeps; anything else stays on this page only. */
const KEPT = new Set('rectangle ellipse diamond text arrow line freedraw frame image'.split(' '));
/** Match the save filter, including image placeholders that cannot be sent yet. */
export const needsSave = (
  known: ShapeStamp | undefined,
  shape: ShapeStamp & { type: string; fileId?: string | null; width: number },
): boolean =>
  KEPT.has(shape.type) &&
  !sameStamp(known, shape) &&
  (shape.type !== 'image' || !!(shape.fileId && shape.width));
