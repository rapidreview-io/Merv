import { idPattern } from '@merv/contracts/schemas';

/** Explicit IDs use the shared record contract; artifact.get remains the authority. */
export function linkArtifactId(explicit: unknown, link: string): string | undefined {
  if (typeof explicit === 'string' && idPattern.test(explicit)) return explicit;
  const target = link.startsWith('merv:') ? link.slice(5) : '';
  return target.startsWith('art_') && idPattern.test(target) ? target : undefined;
}

/** Expansion follows content, not the URL or the size of its label. */
export function linkExpansionMode(
  text: string | undefined,
  artifactId?: string,
): 'none' | 'reading' | 'fullscreen' {
  if (artifactId) return 'fullscreen';
  const content = text?.trim() ?? '';
  const lines = content.split('\n').length;
  // What fits the popup unscrolled is read there; long notes or many structured lines need a
  // document-sized reading surface.
  if (content.length <= 700 && lines <= 12) return 'none';
  return content.length > 1600 || lines > 24 ? 'fullscreen' : 'reading';
}
