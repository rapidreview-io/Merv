/** A lens as a person names it: its perspective in words, `data_quality` as `data quality`. */
export const lensName = (perspective: string) => perspective.replaceAll('_', ' ');
