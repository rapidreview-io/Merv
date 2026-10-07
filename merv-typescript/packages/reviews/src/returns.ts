import { check, type ReviewReturn, type Verdict } from '@merv/contracts';

/**
 * Where a verdict on an owned review sends its work back, by the one rule every reviewing owner
 * applies: a pass names no route; a rejection names one of the owner's routes, or, naming none,
 * takes the one the owner marks `default`. An owner with no routes returns its work by fixed
 * edges and accepts no returnTo at all. Anything else is refused `invalid_review_return`.
 */
export function reviewReturn(
  verdict: Verdict,
  returnTo: unknown,
  routes: readonly ReviewReturn[],
): string | undefined {
  if (verdict === 'pass' || !routes.length) {
    check(
      returnTo === undefined,
      'invalid_review_return',
      verdict === 'pass'
        ? 'A pass accepts no returnTo'
        : 'These reviews return their work by fixed routes and accept no returnTo',
    );
    return undefined;
  }
  const to = returnTo ?? routes.find((route) => route.default)?.value;
  check(
    routes.some((route) => route.value === to),
    'invalid_review_return',
    `A rejection returns to ${routes.map((route) => route.value).join(' or ')}`,
  );
  return to as string;
}
