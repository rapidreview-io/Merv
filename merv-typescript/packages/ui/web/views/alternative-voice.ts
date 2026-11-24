// This opt-in STT/TTS transport has no voice model to detect turns. Capture only:
// loudness never cancels playback. Live does not use these three settings.
const CAPTURE = { startRms: 0.02, continueRms: 0.012, silenceMs: 1_700 } as const;

/** Audio transport only. Every recognized request goes through Merv's existing VoiceRouter. */
export interface VoiceGrant {
  url: string;
  token: string;
  expires: number;
}
type Event = { type: string; [key: string]: unknown };
export class AlternativeVoiceLine {
  private socket?: WebSocket;
  private renewTimer?: ReturnType<typeof setInterval>;
  private processor?: ScriptProcessorNode;
  private source?: MediaStreamAudioSourceNode;
  private sink?: GainNode;
  private sounds = new Set<AudioBufferSourceNode>();
  private epoch = 0;
  private narration: string[] = [];
  private synthesizing = false;
  get pending() {
    return this.synthesizing || this.narration.length > 0 || this.sounds.size > 0;
  }
  private narrateNext() {
    if (this.synthesizing || this.stopped || !this.ready) return;
    const text = this.narration.shift();
    if (!text) return;
    this.synthesizing = true;
    this.write({ type: 'say', text, epoch: this.epoch });
    this.event({ type: 'session.output_transcript.delta', delta: text });
  }
  private next = 0;
  private speech = false;
  private silence = 0;
  private duration = 0;
  private muted = false;
  private stopped = false;
  private ready = false;
  private pre: Int16Array[] = [];
  readonly output: AnalyserNode;
  constructor(
    private context: AudioContext,
    private event: (event: Event) => void,
  ) {
    this.output = context.createAnalyser();
    this.output.connect(context.destination);
  }
  get readyState() {
    return this.ready && !this.stopped ? 'open' : 'closed';
  }
  private write(message: Event) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  async start(grant: VoiceGrant, mic: MediaStream, renew?: () => Promise<VoiceGrant>) {
    await this.context.resume();
    await new Promise<void>((resolve, reject) => {
      const socket = (this.socket = new WebSocket(grant.url));
      const timeout = setTimeout(() => {
        this.close();
        reject(new Error('Alternative voice did not connect. Please retry.'));
      }, 15_000);
      socket.onopen = () => this.write({ type: 'auth', token: grant.token });
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Alternative voice could not be reached.'));
      };
      socket.onclose = () => {
        clearTimeout(timeout);
        reject(new Error('Alternative voice connection closed.'));
        if (!this.stopped) {
          this.event({
            type: 'error',
            message: 'Alternative voice disconnected. Reconnect to continue.',
          });
          this.event({ type: 'session.closed' });
        }
      };
      socket.onmessage = ({ data }) => {
        if (this.stopped) return;
        try {
          const e = JSON.parse(String(data)) as Event;
          if (e.type === 'ready') {
            clearTimeout(timeout);
            this.ready = true;
            resolve();
          } else if (e.type === 'transcript' && typeof e.text === 'string') {
            if (this.muted) return;
            // Reserved recognizer annotations, only when they are the entire result.
            // Embedded text and code, including other bracketed expressions, are unchanged.
            const text = e.text.trim();
            if (
              !/[\p{L}\p{N}]/u.test(text) ||
              /^(?:\[(?:noise|silence|music|inaudible|cough|laughter)\]|\((?:noise|silence|music|inaudible|cough|laughter)\))[.!?…]*$/iu.test(
                text,
              )
            )
              return;
            this.event({ type: 'session.output_audio.cleared' });
            this.cancel();
            this.event({ type: 'session.input_transcript.delta', delta: ` ${text}` });
            this.event({
              type: 'session.delegation.created',
              delegation: { id: crypto.randomUUID() },
            });
          } else if (e.type === 'audio' && e.epoch === this.epoch && typeof e.audio === 'string')
            this.play(e.audio);
          else if (e.type === 'speech.done' && e.epoch === this.epoch) {
            this.synthesizing = false;
            this.narrateNext();
          } else if (e.type === 'error') {
            this.narration = [];
            this.synthesizing = false;
            clearTimeout(timeout);
            reject(
              new Error(typeof e.message === 'string' ? e.message : 'Alternative voice failed.'),
            );
            this.event(e);
          }
        } catch {
          this.event({ type: 'error', message: 'Invalid alternative voice response.' });
        }
      };
    });
    if (this.stopped) throw new Error('Voice session ended.');
    if (renew)
      this.renewTimer = setInterval(() => {
        void renew().then(
          (next) => {
            if (!this.stopped) this.write({ type: 'renew', token: next.token });
          },
          () => {
            if (!this.stopped) {
              this.event({
                type: 'error',
                message: 'Alternative voice authorization expired. Reconnect to continue.',
              });
              this.event({ type: 'session.closed' });
              this.close();
            }
          },
        );
      }, 240_000);
    this.source = this.context.createMediaStreamSource(mic);
    this.processor = this.context.createScriptProcessor(2048, 1, 1);
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.context.destination);
    this.processor.onaudioprocess = ({ inputBuffer }) => {
      if (this.muted || this.stopped) return;
      const x = inputBuffer.getChannelData(0),
        a = new Int16Array(Math.floor((x.length * 16000) / this.context.sampleRate));
      let energy = 0;
      for (const v of x) energy += v * v;
      const rms = Math.sqrt(energy / x.length);
      for (let i = 0; i < a.length; i++) {
        const q = (i * this.context.sampleRate) / 16000,
          j = Math.floor(q);
        const value = x[j] + ((x[j + 1] ?? x[j]) - x[j]) * (q - j);
        a[i] = Math.max(-32768, Math.min(32767, value * 32767));
      }
      if (!this.speech) {
        this.pre.push(a);
        if (this.pre.length > 8) this.pre.shift();
        if (rms < CAPTURE.startRms) return;
        this.speech = true;
        this.silence = 0;
        this.duration = 0;
        // Loudness starts transcription, never cancels playback. Only the completed transcript hands over.
        this.event({ type: 'session.input_speech.started' });
        for (const chunk of this.pre) this.append(chunk);
        this.pre = [];
      } else this.append(a);
      this.duration += a.length / 16000;
      this.silence = rms > CAPTURE.continueRms ? 0 : this.silence + a.length / 16000;
      if (this.silence * 1000 > CAPTURE.silenceMs || this.duration > 25) {
        this.write({ type: 'commit' });
        this.speech = false;
        this.pre = [];
      }
    };
  }
  private append(a: Int16Array) {
    let binary = '';
    for (const b of new Uint8Array(a.buffer)) binary += String.fromCharCode(b);
    this.write({ type: 'audio', audio: btoa(binary) });
  }
  private play(encoded: string) {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer),
      buffer = this.context.createBuffer(1, bytes.length / 2, 24000);
    const values = buffer.getChannelData(0);
    for (let i = 0; i < values.length; i++) values[i] = view.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    this.sounds.add(source);
    const epoch = this.epoch;
    source.onended = () => {
      this.sounds.delete(source);
      // Playback can outlast synthesis by minutes. Keep the line active until audio finishes.
      if (!this.stopped && epoch === this.epoch) this.event({ type: 'session.output_audio.delta' });
    };
    this.next = Math.max(this.context.currentTime + 0.04, this.next);
    source.start(this.next);
    this.next += buffer.duration;
    this.event({ type: 'session.output_audio.delta' });
  }
  private cancel() {
    this.epoch++;
    this.narration = [];
    this.synthesizing = false;
    for (const source of this.sounds) {
      try {
        source.stop();
      } catch {
        /* already ended */
      }
    }
    this.sounds.clear();
    this.next = 0;
    this.write({ type: 'cancel', epoch: this.epoch });
  }
  send(serialized: string) {
    const e = JSON.parse(serialized) as Event;
    if (e.type === 'session.close') {
      this.close();
      this.event({ type: 'session.closed' });
    } else if (e.type === 'session.instructions.append') this.cancel();
    else if (e.type === 'session.input_audio.mute') {
      this.muted = true;
      this.speech = false;
      this.pre = [];
      this.cancel();
      this.write({ type: 'clear' });
    } else if (e.type === 'session.input_audio.unmute') this.muted = false;
    else if (e.type === 'session.commentary.append' && typeof e.content === 'string') {
      // Read aloud as it is: what it is to the voice ("Result", "News") is not said.
      const text = e.content.replace(/^(?:Result|News|Progress):\s*/, '');
      this.narration.push(...narrationChunks(text));
      this.narrateNext();
    }
  }
  close() {
    clearInterval(this.renewTimer);
    if (this.stopped) return;
    this.cancel();
    this.stopped = true;
    this.ready = false;
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
    }
    this.source?.disconnect();
    this.sink?.disconnect();
    this.output.disconnect();
    this.socket?.close();
  }
}

/** Keep the gateway's per-message bound, without discarding any of the answer. */
export function narrationChunks(text: string): string[] {
  const chunks: string[] = [];
  while (text.length > 1800) {
    let end = text.lastIndexOf(' ', 1800);
    if (end < 900) end = 1800;
    else end++; // Keep the separating whitespace so concatenating chunks is lossless.
    if (end > 1800) end = 1800;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks;
}
