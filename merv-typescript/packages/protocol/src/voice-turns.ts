/** Live owns turn detection and barge-in. These are the only shared voice settings. */
export const VOICE_MIC = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} as const;
