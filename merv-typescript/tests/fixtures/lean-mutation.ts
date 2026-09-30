/** Load a transpiled, deliberately broken test copy without changing production files. */
export async function importMutation(javascript: string) {
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
}
