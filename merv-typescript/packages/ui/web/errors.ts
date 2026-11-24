/** Only locally authored copy crosses the error boundary. Provider text stays in diagnostics. */
const MESSAGES: Record<string, string> = {
  offline: "Couldn't reach Merv. Check your connection and try again.",
  mac_offline: "Couldn't reach your Mac. Check the session on your Mac.",
  membership_required: 'You no longer have access to this project. Choose another project.',
  scope_changed: 'The project changed. Try again on this project.',
  owner_changed: 'The account changed. Sign in and try again.',
  spend_limit: 'Your Merv credits are used up until they reset.',
  pi_voice_unavailable: 'Voice could not start. Click the orb to try again.',
  pi_model_changed: 'The model changed. Try sending your message again.',
};
export const TRY_AGAIN = "That didn't work. Please try again.";

/** Safe errors can travel through existing Error consumers without exposing server messages. */
export class PublicError extends Error {}
export function publicError(cause: unknown, fallback = TRY_AGAIN): string {
  if (cause instanceof PublicError) return cause.message;
  console.warn('[Merv]', cause);
  const error = cause as { code?: string; status?: number; name?: string } | null;
  if (error?.name === 'NotAllowedError') return 'Allow microphone access, then try voice again.';
  if (error?.code && Object.hasOwn(MESSAGES, error.code)) return MESSAGES[error.code]!;
  if (error?.status === 401) return 'Please sign in again to continue.';
  if (error?.status === 403) return 'This action is not available to your account.';
  if (error?.status === 429) return 'Merv is busy. Try again in a moment.';
  return fallback;
}
