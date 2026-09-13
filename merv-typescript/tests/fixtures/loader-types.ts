import type {} from 'cordis';

export interface LoaderMarker {
  value: string;
  closed: boolean;
}

declare module 'cordis' {
  interface Context {
    loaderMarker: LoaderMarker;
    loaderConsumer: { observed: string };
  }
}
