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
  if (!content) return 'none';
  // Long notes or many structured lines need a document-sized reading surface.
  return content.length > 1600 || content.split('\n').length > 24 ? 'fullscreen' : 'reading';
}
