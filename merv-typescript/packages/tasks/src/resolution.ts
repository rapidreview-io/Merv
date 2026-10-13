/**
 * Which tasks are merge resolutions: support work that joins deliveries, not research. The
 * titles are the ones resolutionBrief writes; this module imports nothing so a page can use it.
 */
const RESOLUTION_TITLES = ['Integrate GitHub ', 'Merge ‘', 'Make the project check pass on ‘'];

export const isResolution = (title: string) =>
  RESOLUTION_TITLES.some((opening) => title.startsWith(opening));
