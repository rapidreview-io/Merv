/** The theme the page wears: the system's, as index.html follows it, until one is chosen in the shell. */
export const worn = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
/** Told whenever the page changes the theme it wears, for `useSyncExternalStore`. */
export const onWorn = (changed: () => void) => {
  const watch = new MutationObserver(changed);
  watch.observe(document.documentElement, { attributeFilter: ['data-theme'] });
  return () => watch.disconnect();
};
