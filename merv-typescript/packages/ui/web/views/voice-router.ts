import type { Conversation } from './pi-conversation';
import { PiVoiceBackend } from './pi-voice-backend';
import type { VoiceBackend, VoiceChoice, VoiceOutput, VoiceTarget } from './voice-backend';

type Routing = {
  current(): VoiceBackend | undefined;
  conversation(): Conversation | null;
  route(target: VoiceTarget | null): void;
  choice(choice: VoiceChoice | null): void;
  commentary(text: string, delegation: string): void;
  reopen(): void;
};

/**
 * Where what the person says goes. In merv-desktop the voice could also be handed to a session on
 * the person's Mac ("connect me to Claude in merv-desktop"); Merv has no Mac, so every line opens
 * on Merv's own conversation and everything heard goes there.
 */
export class VoiceRouter {
  private greeting?: string;
  constructor(private out: Routing) {}
  open(output: VoiceOutput): VoiceBackend {
    return new PiVoiceBackend(this.out.conversation, output);
  }
  get hasChoice() {
    return false;
  }
  cancelsChoice(_text: string) {
    return false;
  }
  takeGreeting() {
    const greeting = this.greeting;
    this.greeting = undefined;
    return greeting;
  }
  cancelSpokenConnect = () => undefined;
  dismissChoice = () => this.out.choice(null);
  /** Only Merv takes the voice: a session elsewhere is never connected to. */
  connect = (target: VoiceTarget | null) => {
    if (target) return;
    this.dismissChoice();
  };
  async send(held: VoiceBackend, text: string, delegation: string) {
    await held.send(text, delegation);
  }
  close() {}
}
