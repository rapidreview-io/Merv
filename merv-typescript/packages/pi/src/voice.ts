/**
 * Voice: GPT-Live is the conversation's ears and voice, and Pi does the work (founder,
 * 2026-10-08). The person's browser offers WebRTC; Main opens the GPT-Live session with the
 * project's key, in client delegation, and hands back the answer. Every request worth doing
 * becomes a Pi turn on the conversation's own model and tools, sent by the page; GPT-Live only
 * listens, says it heard, and speaks what Pi answered. The key never leaves Main.
 */
import { MervError, check } from '@merv/contracts';
import type { PiCommand } from './types.js';

/** How the voice behaves: it delegates every real request and never answers one itself. */
export const voiceInstructions = `You are the voice of Pi, the research agent inside Merv. You only listen and speak. Pi, your backend, does all real work with its own model and tools.

# Delegation policy
Delegate to the backend when the person:
- asks anything about their project, its work, tasks, experiments, reviews, files, results, paper, code or machines
- asks you to do, start, stop, change, create, find, check, explain or summarise anything
- asks a question that needs facts, judgement or calculation
Do not delegate greetings, thanks, small talk, or a request to repeat what you just said.
While the backend works, say one short acknowledgement such as "On it" or "Let me check", then wait quietly. Never guess, invent or pre-empt the result.

# Speaking results
When the backend's result arrives, say the gist in one to three short sentences, as a person would say it aloud. Do not read tables, code, lists or links; say that the details are on screen. Speak numbers naturally.
If the result says something needs the person's approval, say what it is and that they can tap Run on screen. Never say something was done unless the result says it was.

# Manner
Warm, calm, brief. Let the person interrupt you: stop and listen. If you did not catch something, ask once, briefly.`;

/** The conversation so far, as GPT-Live's seed history: its last turns, short, in order. */
export function voiceHistory(commands: PiCommand[]) {
  const said = commands.flatMap((command) => command.messages).slice(-12);
  const items = said.map((message) => ({
    type: 'message',
    role: message.role,
    content: [
      {
        type: message.role === 'user' ? 'input_text' : 'output_text',
        // The seed holds at most 8,192 tokens across its messages.
        text: message.text.length > 1_800 ? `${message.text.slice(0, 1_800)}…` : message.text,
      },
    ],
  }));
  let budget = 24_000;
  return items
    .reverse()
    .filter((item) => (budget -= item.content[0]!.text.length) >= 0)
    .reverse();
}

export interface VoiceConfig {
  url: string;
  model: string;
  voice: string;
}

/** Opens a GPT-Live session for the browser's WebRTC offer; the answer goes back to the browser. */
export async function openVoice(
  config: VoiceConfig,
  key: string,
  offer: string,
  history: ReturnType<typeof voiceHistory>,
  person: string,
): Promise<{ sessionId: string; sdp: string }> {
  let response: Response;
  try {
    response = await fetch(config.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        // A stable, opaque id for the person, as OpenAI asks of every end user.
        'openai-safety-identifier': person,
      },
      body: JSON.stringify({
        session: {
          model: config.model,
          instructions: voiceInstructions,
          delegation: { type: 'client' },
          audio: { output: { voice: config.voice } },
          store: false,
          input: history,
        },
        transport: { type: 'webrtc', sdp: offer },
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new MervError('pi_voice_unavailable', 'Voice could not be reached', 502);
  }
  const body = (await response.json().catch(() => null)) as {
    session?: { id?: unknown };
    transport?: { sdp?: unknown };
    error?: { message?: unknown };
  } | null;
  check(
    response.ok && typeof body?.transport?.sdp === 'string' && typeof body.session?.id === 'string',
    'pi_voice_unavailable',
    typeof body?.error?.message === 'string' ? body.error.message : 'Voice is unavailable',
    502,
  );
  return { sessionId: body!.session!.id as string, sdp: body!.transport!.sdp as string };
}
