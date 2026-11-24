const LIMIT = 256 * 1024;
const HEAD = 32 * 1024;
const MARKER = '\n… output truncated …\n';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const chunkDecoder = new TextDecoder('utf8', { ignoreBOM: true });
type Chunk = { bytes: Uint8Array; text: string; rest: string };

/** Keep the beginning and latest output without splitting a character or growing forever. */
export class OutputBuffer {
  private head?: string;
  private bytes = 0;
  private last = 0;
  private whole: string | undefined = '';
  private pending = '';
  private front: Chunk[] = [];
  private back: Chunk[] = [];
  private backText = '';

  get text(): string {
    const first = this.front.at(-1);
    return this.whole !== undefined
      ? this.whole
      : this.head + MARKER + (first ? first.text + first.rest : '') + this.backText + this.pending;
  }

  set text(text: string) {
    this.whole = text;
    this.bytes = encoder.encode(text).length;
    this.last = text.charCodeAt(text.length - 1);
    this.front = [];
    this.back = [];
    this.backText = '';
    this.pending = '';
  }

  private push(bytes: Uint8Array) {
    for (let start = 0; start < bytes.length;) {
      let end = Math.min(bytes.length, start + 1024);
      while ((bytes[end]! & 0xc0) === 0x80) end++;
      const part = bytes.slice(start, end),
        text = chunkDecoder.decode(part);
      this.back.push({ bytes: part, text, rest: '' });
      this.backText += text;
      start = end;
    }
  }

  private first(): Chunk | undefined {
    if (!this.front.length) {
      let rest = '';
      while (this.back.length) {
        const chunk = this.back.pop()!;
        chunk.rest = rest;
        rest = chunk.text + rest;
        this.front.push(chunk);
      }
      this.backText = '';
    }
    return this.front.at(-1);
  }

  append(delta: string): string {
    const added = encoder.encode(delta);
    // A pair may arrive in separate deltas before truncation normalizes the text.
    const paired =
      this.last >= 0xd800 &&
      this.last <= 0xdbff &&
      delta.charCodeAt(0) >= 0xdc00 &&
      delta.charCodeAt(0) <= 0xdfff;
    const size = this.bytes + added.length - (paired ? 2 : 0);
    if (size <= LIMIT) {
      this.bytes = size;
      if (delta) this.last = delta.charCodeAt(delta.length - 1);
      if (this.whole !== undefined) this.whole += delta;
      else this.pending += delta;
      return this.text;
    }
    if (this.whole !== undefined) {
      const bytes = encoder.encode(this.whole + delta);
      if (this.head === undefined) {
        let end = HEAD;
        while ((bytes[end]! & 0xc0) === 0x80) end--;
        this.head = decoder.decode(bytes.subarray(0, end));
      }
      const prefix = encoder.encode(this.head + MARKER).length;
      let start = bytes.length - (LIMIT - prefix);
      while ((bytes[start]! & 0xc0) === 0x80) start++;
      const tail = encoder.encode(decoder.decode(bytes.subarray(start)));
      this.push(tail);
      this.bytes = prefix + tail.length;
      this.whole = undefined;
    } else {
      const bytes = this.pending ? encoder.encode(this.pending + delta) : added;
      this.bytes += bytes.length - encoder.encode(this.pending).length;
      this.pending = '';
      this.push(bytes);
      // Two stacks cache the remaining text as ropes; removing a chunk never joins the tail.
      while (this.bytes > LIMIT) {
        const first = this.first()!;
        let start = Math.min(first.bytes.length, this.bytes - LIMIT);
        while ((first.bytes[start]! & 0xc0) === 0x80) start++;
        this.bytes -= start;
        if (start === first.bytes.length) this.front.pop();
        else {
          first.bytes = first.bytes.subarray(start);
          first.text = chunkDecoder.decode(first.bytes);
        }
      }
      // TextDecoder historically consumes a BOM at the start of the retained tail.
      const first = this.first();
      if (first?.text.startsWith('\ufeff')) {
        first.bytes = first.bytes.subarray(3);
        first.text = first.text.slice(1);
        this.bytes -= 3;
        if (!first.bytes.length) this.front.pop();
      }
    }
    this.last = 0; // Retained bytes have no unpaired surrogate.
    return this.text;
  }
}

/** Completed results keep the same limit as live output. */
export const capOutput = (text: string): string => new OutputBuffer().append(text);
