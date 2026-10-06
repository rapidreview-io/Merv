import { colour } from './highlight';
import { parseMarkdown } from './markdown-parse';

/** Reads each text, and colours each code, the page sends, off the page's thread (off-thread.ts). */
addEventListener(
  'message',
  async (event: MessageEvent<string | { code: string; lang: string }>) => {
    const job = event.data;
    if (typeof job === 'string') return postMessage(parseMarkdown(job));
    // The page's clock waits while the highlighter and the grammar download, and runs as they colour.
    postMessage('loading');
    postMessage(await colour(job.code, job.lang, () => postMessage('loaded')));
  },
);
// The page gives a job its time only from here: until now this was still downloading.
postMessage('loaded');
