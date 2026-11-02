import type { Context } from 'cordis';
import {
  chromium,
  type Browser as Chromium,
  type BrowserContext,
  type CDPSession,
  type Frame,
  type Locator,
  type Page,
  type Response,
} from 'playwright-core';
import { z } from 'zod';
import { check, MervError, type Caller, type State } from '@merv/contracts';
import {
  challenged,
  closedAddress,
  fieldFacts,
  guard,
  outlineOf,
  pageLines,
  secretField,
  type Guard,
} from './guard.js';

const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
export const browserConfig = z.strictObject({
  cdpUrlEnv: envName.default('MERV_BROWSER_CDP_URL'),
  cdpTokenEnv: envName.default('MERV_BROWSER_CDP_TOKEN'),
  tokenEnv: envName.default('MERV_BROWSER_RENDER_TOKEN'),
  accountEnv: envName.default('MERV_BROWSER_RENDER_ACCOUNT'),
  renderUrl: z
    .string()
    .default(
      'wss://api.cloudflare.com/client/v4/accounts/{account}/browser-run/devtools/browser?keep_alive=1200000',
    ),
  /** Environment holding the addresses of this deployment, which no page reaches. */
  ownHostsEnv: z
    .array(envName)
    .default(['BOARD_ORIGINS', 'BOARD_SUPABASE_URL', 'SANDBOXES_PUBLIC_API_URL']),
  ownHosts: z.array(z.string()).default([]),
  minutesPerDay: z.number().positive().default(15),
  shotsPerDay: z.number().int().positive().default(30),
  /** Everyone's together: what bounds the bill, since people cost nothing to make. */
  deploymentMinutesPerDay: z.number().positive().default(300),
  sessions: z.number().int().positive().default(10),
  idleMs: z
    .number()
    .int()
    .positive()
    .default(20 * 60_000),
  actionMs: z.number().int().positive().default(8000),
  mostShotBytes: z
    .number()
    .int()
    .positive()
    .default(2 * 1024 ** 2),
});
export type BrowserConfig = z.input<typeof browserConfig>;
export type BrowserSettings = z.infer<typeof browserConfig>;

/** The window: a viewport's picture needs no scaling for a model (short side near 768) or a board. */
const VIEW = { width: 1200, height: 750 };
const MOST_FULL_HEIGHT = VIEW.height * 3;
/** Past this between calls, the person is not being kept waiting by a browser in use. */
const MOST_CHARGE_MS = 120_000;
/** What tool-image.ts lets through as a picture, in base64. */
const MOST_LOOK_CHARS = 700_000;
const KEYS = new Set(
  'Enter Tab Escape Backspace ArrowUp ArrowDown ArrowLeft ArrowRight PageUp PageDown Home End Space'.split(
    ' ',
  ),
);
const migrations: Record<number, string> = {
  1: `CREATE TABLE browser_usage(day TEXT NOT NULL,actor_id TEXT NOT NULL,ms BIGINT NOT NULL,shots INTEGER NOT NULL,PRIMARY KEY(day,actor_id));`,
};

export type Step =
  | { click: string; say?: string }
  | { type: { ref: string; text: string }; say?: string }
  | { scroll: { dy: number }; say?: string }
  | { press: string; say?: string }
  | { wait: number; say?: string };
export interface PageView {
  title: string;
  url: string;
  outline: string;
  cut?: true;
  blocked?: string;
}
export interface Picture {
  bytes: Buffer;
  title: string;
  url: string;
  width: number;
  height: number;
  cropped?: true;
}
interface Session {
  browser: Chromium;
  context: BrowserContext;
  page: Page;
  charged: number;
  idle?: NodeJS.Timeout;
  /** The latest refused main-frame navigation, and the document the page last answered with. */
  refused?: string;
  document?: Response;
  lines: string[];
}

const refusedAddress = (why: string) =>
  new MervError('browser_refused', `The browser does not open ${why}`, 422);
const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);

/**
 * One browser per person, opened by the first call and closed when idle or at shutdown, reached
 * over CDP so any provider, or a Chrome on this computer, serves. Everything a page requests
 * passes the guard; budgets are counted in State, so a restart forgets nothing.
 */
export class BrowserService {
  readonly settings: BrowserSettings;
  private readonly sessions = new Map<string, Promise<Session>>();
  private readonly turns = new Map<string, Promise<unknown>>();
  private readonly allowed: Guard;
  private readonly addressOk: (ip: string) => boolean;

  constructor(
    config: BrowserConfig,
    private readonly state: State,
    options: { guard?: Guard; addressOk?: (ip: string) => boolean } = {},
  ) {
    this.settings = browserConfig.parse(config);
    const own = [
      ...this.settings.ownHosts,
      ...this.settings.ownHostsEnv.flatMap((name) => (process.env[name] ?? '').split(',')),
    ].flatMap((value) => {
      try {
        return value.trim() ? [new URL(value.trim()).hostname.toLowerCase()] : [];
      } catch {
        return [value.trim().toLowerCase()];
      }
    });
    this.allowed = options.guard ?? guard(own);
    this.addressOk = options.addressOk ?? ((ip) => !closedAddress(ip));
  }

  /** Where the browser is, or nothing: then there is no tool at all. */
  private get endpoint() {
    const { cdpUrlEnv, cdpTokenEnv, tokenEnv, accountEnv, renderUrl } = this.settings;
    const plain = process.env[cdpUrlEnv]?.trim();
    const bearer = (token?: string) => (token ? { authorization: `Bearer ${token}` } : undefined);
    if (plain) return { url: plain, headers: bearer(process.env[cdpTokenEnv]?.trim()), own: false };
    const token = process.env[tokenEnv]?.trim();
    const account = process.env[accountEnv]?.trim();
    if (!token || !account) return undefined;
    return { url: renderUrl.replace('{account}', account), headers: bearer(token), own: true };
  }
  get enabled() {
    return !!this.endpoint;
  }
  async initialize() {
    if (this.enabled) await this.state.migrate('browser', migrations);
  }

  private async used(actor: string) {
    const day = new Date().toISOString().slice(0, 10);
    return await this.state.transaction(async (tx) => {
      const mine = await tx.get<{ ms: string | number; shots: number }>(
        'SELECT ms,shots FROM browser_usage WHERE day=? AND actor_id=?',
        day,
        actor,
      );
      const all = await tx.get<{ ms: string | number | null }>(
        'SELECT SUM(ms) AS ms FROM browser_usage WHERE day=?',
        day,
      );
      return {
        ms: Number(mine?.ms ?? 0),
        shots: Number(mine?.shots ?? 0),
        everyone: Number(all?.ms ?? 0),
      };
    });
  }
  private async charge(actor: string, ms: number, shots = 0) {
    await this.state.transaction((tx) =>
      tx.run(
        `INSERT INTO browser_usage(day,actor_id,ms,shots) VALUES(?,?,?,?)
         ON CONFLICT(day,actor_id) DO UPDATE SET ms=browser_usage.ms+excluded.ms,shots=browser_usage.shots+excluded.shots`,
        new Date().toISOString().slice(0, 10),
        actor,
        Math.round(ms),
        shots,
      ),
    );
  }
  private async withinBudget(actor: string) {
    const { minutesPerDay, deploymentMinutesPerDay } = this.settings;
    const { ms, everyone } = await this.used(actor);
    if (ms >= minutesPerDay * 60_000 || everyone >= deploymentMinutesPerDay * 60_000) {
      await this.closeFor(actor);
      throw new MervError(
        'browser_budget',
        ms >= minutesPerDay * 60_000
          ? `That is today's ${minutesPerDay} browser minutes used up. It comes back tomorrow.`
          : 'The browser is used up for everyone today. It comes back tomorrow.',
        429,
      );
    }
  }

  /** One person's calls run one at a time, as one person's browser can. */
  private inTurn<T>(actor: string, run: () => Promise<T>): Promise<T> {
    const next = (this.turns.get(actor) ?? Promise.resolve()).catch(() => undefined).then(run);
    this.turns.set(actor, next);
    return next;
  }
  private use<T>(caller: Caller, run: (session: Session) => Promise<T>): Promise<T> {
    const actor = caller.actorId;
    return this.inTurn(actor, async () => {
      await this.withinBudget(actor);
      const session = await this.session(actor);
      try {
        return await run(session);
      } catch (error) {
        // A page going away under a call is the page's doing: the model hears it plainly.
        if (error instanceof MervError) throw error;
        throw new MervError('browser_page', `The page did not answer: ${firstLine(error)}`, 502);
      } finally {
        const now = Date.now();
        const spent = Math.min(now - session.charged, MOST_CHARGE_MS);
        session.charged = now;
        clearTimeout(session.idle);
        session.idle = setTimeout(() => void this.closeFor(actor), this.settings.idleMs);
        session.idle.unref?.();
        await this.charge(actor, spent);
      }
    });
  }
  private session(actor: string): Promise<Session> {
    const open = this.sessions.get(actor);
    if (open) return open;
    if (this.sessions.size >= this.settings.sessions)
      throw new MervError(
        'browser_busy',
        'Too many people are using the browser right now. Try again in a little while.',
        429,
      );
    const opening = this.opened(actor).catch((error) => {
      this.sessions.delete(actor);
      throw error;
    });
    this.sessions.set(actor, opening);
    return opening;
  }
  private async opened(actor: string): Promise<Session> {
    const endpoint = this.endpoint;
    check(endpoint, 'browser_unavailable', 'There is no browser here', 503);
    let browser: Chromium;
    try {
      browser = await chromium.connectOverCDP(endpoint.url, {
        headers: endpoint.headers,
        timeout: 15_000,
      });
    } catch {
      // Never the error itself: it may carry the address with the account in it.
      throw new MervError('browser_unavailable', 'The browser could not be started', 503);
    }
    browser.once('disconnected', () => this.sessions.delete(actor));
    // Fresh, so nothing is signed in and nothing is kept.
    const context = await browser.newContext({
      viewport: VIEW,
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: 'block',
      locale: 'en-US',
    });
    const session: Session = {
      browser,
      context,
      page: undefined as never,
      charged: Date.now(),
      lines: [],
    };
    // Every first request, in every frame and worker of the context.
    await context.route('**/*', async (route) => {
      const request = route.request();
      const why = await this.allowed(request.url());
      if (!why) return await route.fallback();
      if (request.isNavigationRequest() && request.frame() === session.page?.mainFrame())
        session.refused = why;
      await route.abort('blockedbyclient');
    });
    await context.routeWebSocket(/./, (socket) => socket.close());
    session.page = await context.newPage();
    const { page } = session;
    page.setDefaultTimeout(this.settings.actionMs);
    page.setDefaultNavigationTimeout(this.settings.actionMs);
    page.on('response', (response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame())
        session.document = response;
    });
    await this.guardRedirects(session, page);
    // Frames another process draws have their own target, so their own guard.
    page.on('framenavigated', (frame) => void this.guardRedirects(session, frame));
    // A new window is refused; where it was going, if allowed, opens in the one window there is.
    context.on('page', (popup) => {
      if (popup === page) return;
      void (async () => {
        const url = await popup.waitForURL(/^(?!about:blank)/, { timeout: 2000 }).then(
          () => popup.url(),
          () => popup.url(),
        );
        await popup.close().catch(() => undefined);
        if (/^https?:/.test(url) && !(await this.allowed(url)))
          await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      })();
    });
    return session;
  }
  /**
   * Playwright never shows a route the hops of a redirect, so a public page could send the browser
   * to a private one: CDP's own interception, on each target, sees every hop.
   */
  private readonly guarded = new WeakSet<Page | Frame>();
  private async guardRedirects(session: Session, target: Page | Frame) {
    if (this.guarded.has(target)) return;
    this.guarded.add(target);
    let cdp: CDPSession;
    try {
      cdp = await session.context.newCDPSession(target);
    } catch {
      this.guarded.delete(target);
      return; // A frame in its parent's process: its parent's guard covers it.
    }
    cdp.on('Fetch.requestPaused', (event) => {
      void (async () => {
        const why = await this.allowed(event.request.url);
        if (why && event.resourceType === 'Document') session.refused = why;
        await (why
          ? cdp.send('Fetch.failRequest', {
              requestId: event.requestId,
              errorReason: 'BlockedByClient',
            })
          : cdp.send('Fetch.continueRequest', { requestId: event.requestId }));
      })().catch(() => undefined);
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }).catch(() => undefined);
  }

  /** What is on the page now, as the model is given it; refused or rebound pages go blank. */
  private async view(session: Session, failed?: unknown): Promise<PageView> {
    const { page } = session;
    const left = async (why: string) => {
      session.refused = undefined;
      session.document = undefined;
      await page.goto('about:blank').catch(() => undefined);
      throw refusedAddress(why);
    };
    const landed = page.url();
    if (session.refused && (failed || !/^https?:/.test(landed))) await left(session.refused);
    session.refused = undefined;
    // What the guard resolved may not be what the browser reached: a host can answer differently.
    const reached = await session.document?.serverAddr().catch(() => null);
    if (reached && !this.addressOk(reached.ipAddress)) await left('a private address');
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    // Playwright 1.57 has no public way to a snapshot with refs; its version is pinned.
    const snapshot = await (
      page as unknown as { _snapshotForAI(o: { timeout: number }): Promise<{ full: string }> }
    )._snapshotForAI({ timeout: this.settings.actionMs });
    session.lines = pageLines(snapshot.full);
    const title = await page.title();
    const text = session.lines.filter((line) => !/^- (link|button)/.test(line)).join(' ');
    return {
      title,
      url: /^https?:/.test(page.url()) ? page.url() : (session.document?.url() ?? page.url()),
      ...outlineOf(session.lines),
      ...(challenged(title, text, session.document?.status()) && {
        blocked:
          'The site refused or put a challenge in the way. Nothing here gets past one: say so, and try another source.',
      }),
    };
  }
  private async go(session: Session, url: string) {
    let failed: unknown;
    session.refused = undefined;
    session.document = undefined;
    try {
      await session.page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      failed = error;
    }
    // An error status with an empty body is an error to Chrome, and an answer to the agent.
    if (failed && !session.refused && !session.document && !/timeout/i.test(firstLine(failed)))
      throw new MervError('browser_page', `The page did not open: ${firstLine(failed)}`, 502);
    return failed;
  }

  async open(caller: Caller, url: string): Promise<PageView> {
    const why = await this.allowed(url);
    if (why) throw refusedAddress(why);
    check(/^https?:/i.test(url), 'browser_refused', 'The browser opens http and https only', 422);
    return await this.use(caller, async (session) => {
      const failed = await this.go(session, url);
      return await this.view(session, failed);
    });
  }
  private hasPage(session: Session) {
    check(/^https?:/.test(session.page.url()), 'browser_no_page', 'Open a page first', 409);
  }
  async find(caller: Caller, query: string) {
    return await this.use(caller, async (session) => {
      this.hasPage(session);
      const { title, url, blocked } = await this.view(session);
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const lines = session.lines.filter((line) =>
        words.every((word) => line.toLowerCase().includes(word)),
      );
      return { title, url, matches: lines.slice(0, 30), count: lines.length, blocked };
    });
  }
  async act(caller: Caller, steps: Step[], say: (line: string) => void) {
    return await this.use(caller, async (session) => {
      this.hasPage(session);
      const { page } = session;
      let done = 0;
      let failure: string | undefined;
      let failed: unknown;
      session.refused = undefined;
      for (const step of steps) {
        if (step.say) say(step.say);
        // A click or a key may navigate, a moment later: give it that moment, then its load.
        const navigated =
          'click' in step || 'press' in step
            ? page
                .waitForEvent('framenavigated', {
                  timeout: 1000,
                  predicate: (frame) => frame === page.mainFrame(),
                })
                .catch(() => undefined)
            : undefined;
        try {
          await this.step(page, step);
          done += 1;
          await navigated;
        } catch (error) {
          failed = error;
          failure = firstLine(error);
          break;
        }
      }
      return {
        done,
        ...(failure && { failed: { step: done, error: failure } }),
        ...(await this.view(session, failed)),
      };
    });
  }
  private async step(page: Page, step: Step) {
    const at = (ref: string) => page.locator(`aria-ref=${ref}`);
    const facts = (element: Locator) => element.evaluate(fieldFacts);
    if ('click' in step) {
      const element = at(step.click);
      const { type } = await facts(element);
      if (type === 'file') throw new Error('File inputs are refused: nothing here uploads');
      await element.click();
    } else if ('type' in step) {
      const element = at(step.type.ref);
      const field = await facts(element);
      if (field.type === 'file') throw new Error('File inputs are refused: nothing here uploads');
      if (secretField(field))
        throw new Error('Password and payment fields are refused: the person types those');
      await element.fill(step.type.text);
    } else if ('scroll' in step) {
      await page.mouse.wheel(0, step.scroll.dy);
      await page.waitForTimeout(150);
    } else if ('press' in step) {
      // Named keys alone: letters pressed one by one would get round the check on typing.
      if (!KEYS.has(step.press)) throw new Error(`Only named keys are pressed: ${[...KEYS]}`);
      await page.keyboard.press(step.press);
    } else await page.waitForTimeout(Math.min(step.wait, this.settings.actionMs));
  }

  /** The page as a JPEG, smaller until it fits: the viewport, an element within it, or the page
   *  down to three windows' height. */
  private async picture(
    session: Session,
    { ref, full }: { ref?: string; full?: boolean },
    qualities: number[],
    mostBytes: number,
  ): Promise<Picture> {
    const { page } = session;
    this.hasPage(session);
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    let cropped = false;
    if (ref) {
      const element = page.locator(`aria-ref=${ref}`);
      await element.scrollIntoViewIfNeeded();
      const box = await element.boundingBox();
      check(box, 'browser_no_element', 'That element is not on the page now', 409);
      const x = Math.max(0, box.x);
      const y = Math.max(0, box.y);
      const width = Math.min(box.x + box.width, VIEW.width) - x;
      const height = Math.min(box.y + box.height, VIEW.height) - y;
      check(width >= 1 && height >= 1, 'browser_no_element', 'That element is not showing', 409);
      clip = { x, y, width, height };
      cropped = width < box.width || height < box.height;
    } else if (full) {
      const tall = await page.evaluate(() => document.documentElement.scrollHeight);
      clip = { x: 0, y: 0, width: VIEW.width, height: Math.min(tall, MOST_FULL_HEIGHT) };
      cropped = tall > MOST_FULL_HEIGHT;
    }
    for (const quality of qualities) {
      const bytes = await page.screenshot({
        type: 'jpeg',
        quality,
        fullPage: !!full && !ref,
        ...(clip && { clip }),
      });
      if (bytes.length <= mostBytes)
        return {
          bytes,
          title: await page.title(),
          url: page.url(),
          width: Math.round(clip?.width ?? VIEW.width),
          height: Math.round(clip?.height ?? VIEW.height),
          ...(cropped && { cropped: true as const }),
        };
    }
    throw new MervError('browser_too_large', 'That picture is too large to keep', 413);
  }
  async look(caller: Caller, ref?: string) {
    return await this.use(caller, (session) =>
      this.picture(session, { ref }, [72, 45], (MOST_LOOK_CHARS / 4) * 3 - 3),
    );
  }
  /** A picture for a board, counted against the day's shots. */
  async shot(caller: Caller, input: { ref?: string; full?: boolean }) {
    const { shotsPerDay, mostShotBytes } = this.settings;
    return await this.use(caller, async (session) => {
      const { shots } = await this.used(caller.actorId);
      if (shots >= shotsPerDay)
        throw new MervError(
          'browser_budget',
          `That is today's ${shotsPerDay} screenshots used up. They come back tomorrow.`,
          429,
        );
      const { blocked, url } = await this.view(session);
      check(
        !blocked,
        'browser_blocked',
        `${url} is showing a challenge: there is nothing to keep`,
        422,
      );
      const picture = await this.picture(session, input, [85, 70, 50], mostShotBytes);
      await this.charge(caller.actorId, 0, 1);
      return picture;
    });
  }
  async closeFor(actor: string) {
    const opening = this.sessions.get(actor);
    this.sessions.delete(actor);
    const session = await opening?.catch(() => undefined);
    if (!session) return;
    clearTimeout(session.idle);
    await session.context.close().catch(() => undefined);
    // A provider's browser stays billed through keep_alive unless told to go; one on someone's
    // own address may be theirs, and Playwright only disconnects from it.
    if (this.endpoint?.own)
      await session.browser
        .newBrowserCDPSession()
        .then((cdp) => cdp.send('Browser.close'))
        .catch(() => undefined);
    await session.browser.close().catch(() => undefined);
  }
  async close() {
    await Promise.all([...this.sessions.keys()].map((actor) => this.closeFor(actor)));
  }
}

declare module 'cordis' {
  interface Context {
    browser: BrowserService;
  }
}

export const browserPlugin = {
  name: 'merv-browser',
  inject: ['state'],
  Config: browserConfig.default({}),
  async apply(ctx: Context, config: BrowserConfig) {
    const browser = new BrowserService(config, ctx.state);
    await browser.initialize();
    ctx.effect(() => () => void browser.close());
    ctx.provide('browser', browser);
  },
};
export default browserPlugin;
