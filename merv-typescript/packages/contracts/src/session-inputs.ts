/** A caller-generated session or agent credential: ms_ followed by 43 base64url characters. */
export const sessionSecretPattern = /^ms_[A-Za-z0-9_-]{43}$/;
/** The most a runner keeps of one session's own output as its transcript. */
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
