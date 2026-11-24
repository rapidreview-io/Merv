export interface VoiceOptions {
  alternative: boolean;
  preferenceKey: string;
}
export function alternativeSelected(options: VoiceOptions): boolean {
  try {
    return localStorage.getItem(`merv:voice:${options.preferenceKey}`) === 'alternative';
  } catch {
    return false;
  }
}
export function selectAlternative(options: VoiceOptions, enabled: boolean) {
  localStorage.setItem(
    `merv:voice:${options.preferenceKey}`,
    enabled && options.alternative ? 'alternative' : 'gpt',
  );
  window.dispatchEvent(new Event('merv:voice-preference'));
}
