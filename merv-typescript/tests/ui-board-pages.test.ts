import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const { mount, unmount } = await import(new URL('./ui-render.js', import.meta.url).href);
const React = await import('react');
const activity = await import('../packages/ui/web/views/board-page-activity');
const address = await import('../packages/ui/web/views/web-address.js');
const jsx = await import('react/jsx-runtime');
const { act, createElement } = React;
const compiled = ts.transpile(
  readFileSync(new URL('../packages/ui/web/views/board-pages.tsx', import.meta.url), 'utf8'),
  {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
);
function fixture(touch = false, width = 1280) {
  let id = 0;
  const timers = new Map<number, () => void>();
  const shots: ((value: string) => void)[] = [];
  let hear!: (event: any) => void;
  const exports: any = {};
  runInNewContext(compiled + '\nexports.PageCard = PageCard;', {
    exports,
    screen: { width },
    innerWidth: width,
    innerHeight: 900,
    URL,
    location,
    // A phone: a coarse pointer and no hover. Without it, matchMedia is not there at all, as on the desktop before.
    ...(touch && { matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' }) }),
    window: {
      mervApp: {
        onPage(fn: typeof hear) {
          hear = fn;
        },
        snap: () => new Promise<string>((resolve) => shots.push(resolve)),
      },
    },
    setTimeout: (fn: () => void) => {
      timers.set(++id, fn);
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    require: (name: string) => {
      if (name === 'react') return React;
      if (name === '../board-app/phone-back') return { useBackCloses() {} };
      if (name === './board-page-activity') return activity;
      if (name === 'react/jsx-runtime') return jsx;
      if (name === '@excalidraw/excalidraw')
        return {
          CaptureUpdateAction: {},
          newElementWith: (el: any, fields: any) => ({ ...el, ...fields }),
        };
      if (name === '../board-app/board-view' || name.endsWith('.css')) return {};
      if (name === './web-address') return { ...address, site: (url: string) => url };
      throw Error(name);
    },
  });
  const changes: any[] = [];
  const page = {
    id: 'card',
    x: 10,
    y: 20,
    width: 800,
    height: 500,
    customData: { browser: 'https://site.invalid' },
  };
  let atX = 0;
  const api = {
    getAppState: () => ({
      scrollX: atX - page.x,
      scrollY: -page.y,
      zoom: { value: 1 },
      offsetLeft: 0,
      offsetTop: 0,
    }),
    getSceneElements: () => [page],
    updateScene(update: any) {
      changes.push(update);
    },
  };
  let move!: React.Dispatch<React.SetStateAction<number>>;
  function Fixture() {
    const [x, setX] = React.useState(0);
    move = setX;
    const tracker = React.useMemo(() => activity.pageActivity(api as never), []);
    atX = x;
    React.useEffect(tracker.listen, [tracker]);
    React.useEffect(tracker.check);
    return createElement(exports.PageCard, {
      page,
      api,
      activity: tracker,
      board: 'board',
      zoom: 1,
      at: { x, y: 0 },
    });
  }
  const bounds = () => {
    document.querySelector('iframe')!.getBoundingClientRect = () =>
      ({ x: 0, y: 40, width: 800, height: 460 }) as DOMRect;
  };
  const render = async () => {
    await mount(createElement(Fixture));
    bounds();
    document.querySelector('section')!.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 500,
        x: 0,
        y: 0,
        width: 800,
        height: 500,
      }) as DOMRect;
  };
  return {
    hear: (event: any) =>
      act(async () => hear({ name: 'merv-page:card', board: 'board', ...event })),
    changes,
    shots,
    render,
    pan: () =>
      act(async () => {
        move((x) => x + 100);
      }),
    runTimers: async () => {
      const queued = [...timers.values()];
      timers.clear();
      await act(async () => {
        queued.forEach((fn) => fn());
      });
    },
    load: () =>
      act(async () => {
        bounds();
        document.querySelector('iframe')!.dispatchEvent(new Event('load'));
      }),
    wake: () =>
      act(async () => {
        document
          .querySelector('section')!
          .dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      }),
    reload: () =>
      act(async () => {
        (document.querySelector('[aria-label="Reload"]') as HTMLButtonElement).click();
      }),
    resting: () => !!document.querySelector('.is-resting'),
  };
}

test('a cancelled page drag releases its listeners without applying cancellation coordinates', async (t) => {
  t.after(unmount);
  for (const selector of ['.canvas-page-bar', '.canvas-page-corner']) {
    const f = fixture();
    await f.render();
    const pointer = (type: string, x: number) =>
      new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: x });
    await act(async () =>
      document.querySelector(selector)!.dispatchEvent(pointer('pointerdown', 50)),
    );
    await act(async () => window.dispatchEvent(pointer('pointermove', 60)));
    assert.equal(f.changes.length, 1);
    await act(async () => window.dispatchEvent(pointer('pointercancel', 0)));
    assert.equal(document.querySelector('.is-holding'), null);
    await act(async () => {
      window.dispatchEvent(pointer('pointermove', 100));
      window.dispatchEvent(pointer('pointerup', 100));
    });
    assert.equal(f.changes.length, 1, 'neither cancellation nor another finger moves the card');
    await unmount();
  }
});

test('shared iframe policy preserves card-only top navigation and strips this site’s origin', () => {
  const base =
    'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
  for (const top of [false, true])
    for (const own of [false, true]) {
      assert.equal(
        address.pageSandbox(own ? location.origin + '/page' : 'https://external.invalid', top),
        base +
          (top ? ' allow-top-navigation-by-user-activation' : '') +
          (own ? '' : ' allow-same-origin'),
      );
    }
});
