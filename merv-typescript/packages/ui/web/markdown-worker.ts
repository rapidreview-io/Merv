import { parseMarkdown } from './markdown-parse';

/** Reads each text the page sends, off the page's thread (`useTree` in markdown.tsx). */
addEventListener('message', (event: MessageEvent<string>) =>
  postMessage(parseMarkdown(event.data)),
);
