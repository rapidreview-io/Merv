import { publicError } from '../errors';
import type { Conversation } from './pi-conversation';
import {
  agentName,
  asksConnect,
  choicePrompt,
  readTarget,
  resolveConnect,
  saysBackToMerv,
  saysChoice,
  connectTargets,
  type VoiceChoice,
  type VoiceTarget,
} from './desk-voice';
import { DeskVoiceBackend } from './desk-voice-backend';
import { PiVoiceBackend } from './pi-voice-backend';
import type { VoiceBackend, VoiceOutput } from './voice-backend';

type Routing = {
  current(): VoiceBackend | undefined;
  conversation(): Conversation | null;
  route(target: VoiceTarget | null): void;
  choice(choice: VoiceChoice | null): void;
  commentary(text: string, delegation: string): void;
  reopen(): void;
};

/** Selection owns its candidates, epochs and delayed connections; each open line gets one backend. */
export class VoiceRouter {
  private target: VoiceTarget | null = null;
  private choosing: VoiceChoice | null = null;
  private version = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private returning = new Set<ReturnType<typeof setTimeout>>();
  private greeting?: string;
  constructor(private out: Routing) {}
  open(output: VoiceOutput): VoiceBackend {
    return this.target
      ? new DeskVoiceBackend(this.target, output)
      : new PiVoiceBackend(this.out.conversation, output);
  }
  get hasChoice() {
    return !!this.choosing;
  }
  cancelsChoice(text: string) {
    return (
      this.hasChoice && /^(?:no|cancel|never mind|nevermind|stay here)[.!?]*$/i.test(text.trim())
    );
  }
  takeGreeting() {
    const greeting = this.greeting;
    this.greeting = undefined;
    return greeting;
  }
  cancelSpokenConnect = () => {
    this.version++;
    clearTimeout(this.timer);
    this.timer = undefined;
  };
  dismissChoice = () => {
    this.cancelSpokenConnect();
    this.choosing = null;
    this.out.choice(null);
  };
  connect = (target: VoiceTarget | null) => {
    this.dismissChoice();
    const held = this.out.current();
    if (held && held.target === target) return;
    this.target = target;
    this.out.route(target);
    this.greeting = target
      ? `You're connected to ${agentName(target.provider)}, in ${target.title}. Go ahead.`
      : held?.target
        ? "Back with Merv. What's next?"
        : undefined;
    if (held) this.out.reopen();
  };
  async send(held: VoiceBackend, text: string, delegation: string) {
    const out = this.out,
      pendingChoice = this.choosing,
      board = out.conversation()?.selected;
    // A pending choice owns the next answer: never send it into the current session.
    if (pendingChoice && !asksConnect(text)) {
      if (this.cancelsChoice(text)) {
        this.dismissChoice();
        return out.commentary('Staying here.', delegation);
      }
      if (saysBackToMerv(text) || /^merv[.!?]*$/i.test(text)) {
        this.dismissChoice();
        this.connect(null);
        return;
      }
      // A correction owns the next selection even if it still needs clarification.
      this.cancelSpokenConnect();
      const target = saysChoice(text, pendingChoice.targets);
      if (!target)
        return out.commentary(
          pendingChoice.clarification ?? choicePrompt(pendingChoice.targets.length),
          delegation,
        );
      return this.connectSpoken(held, target, delegation, this.version);
    }
    if (asksConnect(text)) {
      this.dismissChoice();
      const version = this.version;
      const { targets, connected } = await connectTargets(text).catch(() => ({
        targets: [],
        connected: undefined,
      }));
      if (out.current() !== held) return;
      if (this.version !== version)
        return out.commentary(
          'The voice selection changed; that request was cancelled.',
          delegation,
        );
      const resolved = resolveConnect(text, targets);
      if (resolved) {
        if (connected === undefined)
          return out.commentary('Your Mac could not be reached.', delegation);
        if (resolved.clarification || resolved.targets.length > 1) {
          this.choosing = resolved;
          out.choice(resolved);
          return out.commentary(
            resolved.clarification ?? choicePrompt(resolved.targets.length),
            delegation,
          );
        }
        const target = resolved.targets[0];
        if (!target)
          return out.commentary(
            connected === false
              ? 'Your Mac is not connected, so I cannot reach that agent.'
              : 'I could not find that session. Pick it beside the orb.',
            delegation,
          );
        return this.connectSpoken(held, target, delegation, version);
      }
    }
    if (held.target && saysBackToMerv(text)) {
      out.commentary('Handing you back to Merv.', delegation);
      const timer = setTimeout(() => {
        this.returning.delete(timer);
        this.connect(null);
      }, 1_500);
      this.returning.add(timer);
      return;
    }
    if (!held.target && out.conversation()?.selected !== board)
      return out.commentary(
        'The board changed. Please repeat that request on this board.',
        delegation,
      );
    await held.send(text, delegation);
  }
  /** Spoken selection authorizes the existing voice connection, but the Mac must still allow it. */
  private async connectSpoken(
    held: VoiceBackend,
    target: VoiceTarget,
    delegation: string,
    version: number,
  ) {
    const out = this.out;
    if (target.capabilities && !target.capabilities.message)
      return out.commentary(
        target.unavailable || 'That session can be read, but cannot take messages.',
        delegation,
      );
    try {
      const now = target.thread ? await readTarget(target) : undefined;
      if (out.current() !== held) return;
      if (this.version !== version)
        return out.commentary(
          'The voice selection changed; that request was cancelled.',
          delegation,
        );
      if (now && !now.drivable)
        return out.commentary(
          'That session is held by its terminal. It can be read, but cannot take messages.',
          delegation,
        );
      out.commentary(
        `Connecting you to ${agentName(target.provider)}${target.thread ? '' : ` in ${target.label}`}.`,
        delegation,
      );
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (out.current() === held && this.version === version)
          this.connect({ ...target, title: now?.title || target.title });
      }, 1_500);
    } catch (error) {
      if (out.current() === held && this.version === version)
        out.commentary(publicError(error), delegation);
    }
  }
  close() {
    this.cancelSpokenConnect();
    for (const timer of this.returning) clearTimeout(timer);
    this.returning.clear();
  }
}
