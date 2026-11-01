import { speech } from '../speech';

/** First of all this app's imports: the pages it shares read this as they load. */
Object.assign(speech, { app: 'Board', agent: 'Pi', boardOnly: true });
