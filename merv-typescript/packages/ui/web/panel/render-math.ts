const MAX_MATH_LENGTH = 8_000;
let katex: Promise<typeof import('katex')> | undefined;

/** KaTeX escapes source and disallows HTML, remote URLs, and unbounded macro expansion. */
export async function renderMath(
  text: string,
  displayMode: boolean,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (signal?.aborted || text.length > MAX_MATH_LENGTH) return;
  try {
    const { default: math } = await (katex ??= import('katex').catch((error) => {
      katex = undefined;
      throw error;
    }));
    if (signal?.aborted) return;
    return math.renderToString(text, {
      displayMode,
      output: 'htmlAndMathml',
      throwOnError: true,
      trust: false,
      strict: 'error',
      maxExpand: 500,
      maxSize: 10,
    });
  } catch {
    return;
  }
}
