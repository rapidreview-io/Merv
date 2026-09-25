/**
 * Bounds an answer meets end to end, shared by Main and the worker. The model's own maximum ends an
 * answer first: each model in MERV_PI_MODELS writes at most 128,000 tokens, about 500,000
 * characters of prose or code. Each bound here is a safety bound far beyond that
 * (docs/PI_IMPLEMENTATION_STATUS.md).
 */

/** One answer's text, as streamed, stored and shown: sixteen characters for every token of the
 * model's maximum, four times a real answer's longest. */
export const messageChars = 2_000_000;

/** A turn's one ceiling once claimed: the model's maximum answer takes under an hour even at 40
 * tokens a second. A turn that stops making progress ends long before (turnTimeoutSeconds). */
export const turnCeilingMs = 3 * 60 * 60_000;
