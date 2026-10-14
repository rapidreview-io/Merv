/**
 * The agent looks at the person's screen (founder, 2026-10-08). Pi asks with screen.look; the
 * person's open page answers with a snapshot of itself exactly as it stands (its DOM with its
 * styles inlined, form values, scroll offsets and window size), so an open menu, a half-typed
 * draft and the scroll position all come out as they are, and no credential is minted. Main has
 * Cloudflare's headless browser draw the snapshot at the window's size, scaled so the shorter side
 * is at most 768 px (all a vision model reads in detail), as a JPEG; then Pi's own model looks at
 * that picture and answers the agent's question in words.
 */
import { MervError, check } from '@merv/contracts';
import { RESPONSES_URL } from '@merv/fleet/model-ledger';

export interface ScreenShot {
  /** Where the page was: its path and query in the app, as the address bar showed it. */
  path: string;
  html: string;
  width: number;
  height: number;
}

/** The person's page, answering the agent: a look with its snapshot, a show with where it went
 *  or why it could not. */
export interface ScreenAnswer {
  shot?: ScreenShot;
  opened?: { path: string; title: string };
  missing?: string;
}

export interface ScreenConfig {
  /** Cloudflare's Browser Run screenshot endpoint, with `{account}` for the account id. */
  url: string;
  tokenEnv: string;
  accountEnv: string;
}

/** The scale that brings the shorter side to at most 768 px: a vision model reads no finer. */
export const scaleFor = (width: number, height: number) =>
  Math.min(1, 768 / Math.min(width, height));

/** The snapshot as a picture: Cloudflare's browser draws it at the person's window size. */
export async function renderScreen(config: ScreenConfig, shot: ScreenShot): Promise<Buffer> {
  const token = process.env[config.tokenEnv];
  const account = process.env[config.accountEnv];
  check(token && account, 'pi_screen_unavailable', 'Seeing the screen is not set up here', 503);
  let response: Response;
  try {
    response = await fetch(config.url.replace('{account}', account), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        html: shot.html,
        viewport: {
          width: shot.width,
          height: shot.height,
          deviceScaleFactor: scaleFor(shot.width, shot.height),
        },
        screenshotOptions: { type: 'jpeg', quality: 72 },
        gotoOptions: { waitUntil: 'networkidle0', timeout: 15_000 },
        // The snapshot carries each scrolled box's offsets; they are put back before the picture.
        addScriptTag: [{ content: restoreScroll }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new MervError('pi_screen_unavailable', 'The screen could not be drawn', 502);
  }
  const type = response.headers.get('content-type') ?? '';
  check(
    response.ok && type.startsWith('image/'),
    'pi_screen_unavailable',
    'The screen could not be drawn',
    502,
  );
  return Buffer.from(await response.arrayBuffer());
}

/** Runs in the drawn page: scroll every box the snapshot marked, then the window. */
const restoreScroll = `for (const box of document.querySelectorAll('[data-merv-scroll]')) {
  const [top, left] = box.getAttribute('data-merv-scroll').split(',').map(Number);
  box.scrollTop = top; box.scrollLeft = left;
}
const page = document.documentElement.getAttribute('data-merv-page-scroll');
if (page) { const [y, x] = page.split(',').map(Number); window.scrollTo(x, y); }`;

/** The request that has Pi's own model look at the picture and answer what the agent asked. */
export const screenRequest = (model: string, question: string, picture: Buffer, path: string) => ({
  model,
  reasoning: { effort: 'low' },
  max_output_tokens: 1_500,
  store: false,
  input: [
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: `This is a screenshot of the Merv app as the person sees it now, at ${path}. Answer for their agent, which cannot see it: ${question || 'Describe what is on the screen.'}\nSay what is shown and where, quote the names, numbers and states visible, and say if something the question asks about is not on screen. No preamble.`,
        },
        {
          type: 'input_image',
          image_url: `data:image/jpeg;base64,${picture.toString('base64')}`,
          detail: 'high',
        },
      ],
    },
  ],
});

/**
 * That request, sent: the model's answer in words, '' when it gave none (never the provider's own
 * words, which name a refused key). `usage` settles its charge as the relay settles a call's: none
 * where the provider refused it, and null, keeping the charge, where it may have run it.
 */
export async function describeScreen(
  key: string,
  body: ReturnType<typeof screenRequest>,
): Promise<{
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}> {
  let response: Response;
  try {
    response = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return { text: '', usage: null };
  }
  const answer = (await response.json().catch(() => null)) as {
    output?: { type?: string; content?: { type?: string; text?: string }[] }[];
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  } | null;
  const count = (value: unknown) => (Number.isSafeInteger(value) ? Number(value) : 0);
  const text = (answer?.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('\n')
    .trim();
  return {
    text: response.ok ? text : '',
    usage: !response.ok
      ? { inputTokens: 0, outputTokens: 0 }
      : answer?.usage
        ? {
            inputTokens: count(answer.usage.input_tokens),
            outputTokens: count(answer.usage.output_tokens),
          }
        : null,
  };
}
