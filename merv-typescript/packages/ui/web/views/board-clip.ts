/** Records the replay's canvases, with its spoken line burned into each frame. */
export function recordClip(root: HTMLElement, caption: () => string) {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream)
    throw new Error('Video recording is unavailable in this browser');
  const mimeType = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/mp4',
    'video/webm',
  ].find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('Video recording is unavailable in this browser');
  const canvas = document.createElement('canvas');
  const box = root.getBoundingClientRect();
  canvas.width = Math.round(box.width);
  canvas.height = Math.round(box.height);
  const ctx = canvas.getContext('2d')!;
  const paint = () => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const source of root.querySelectorAll<HTMLCanvasElement>(
      'canvas.static, canvas.board-reveal',
    )) {
      if (!source.width || !source.height || source.classList.contains('interactive')) continue;
      const rect = source.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      ctx.filter = getComputedStyle(source).filter;
      ctx.drawImage(source, rect.left - box.left, rect.top - box.top, rect.width, rect.height);
    }
    ctx.filter = 'none';
    const words = caption();
    if (!words) return;
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    const lines: string[] = [''];
    for (const word of words.split(/\s+/)) {
      const last = lines.length - 1;
      if (ctx.measureText(`${lines[last]} ${word}`).width > canvas.width - 64 && lines[last])
        lines.push(word);
      else lines[last] = `${lines[last]} ${word}`.trim();
    }
    const height = lines.length * 28 + 20;
    ctx.fillStyle = 'rgba(0,0,0,.8)';
    ctx.fillRect(16, canvas.height - height - 16, canvas.width - 32, height);
    ctx.fillStyle = '#fff';
    lines.forEach((line, i) =>
      ctx.fillText(line, canvas.width / 2, canvas.height - height + 14 + i * 28),
    );
  };
  paint();
  const stream = canvas.captureStream(30);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType });
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  const chunks: Blob[] = [];
  let keep = true;
  let timer: ReturnType<typeof setInterval>;
  const cleanup = () => {
    clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
  };
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.onerror = () => {
    keep = false;
    cleanup();
  };
  recorder.onstop = () => {
    cleanup();
    if (!keep || !chunks.length) return;
    const url = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `board-clip.${recorder.mimeType.includes('mp4') ? 'mp4' : 'webm'}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  try {
    recorder.start();
    timer = setInterval(paint, 1000 / 30);
  } catch (error) {
    cleanup();
    throw error;
  }
  return (save = true) => {
    keep = save;
    clearInterval(timer);
    if (recorder.state !== 'inactive') recorder.stop();
    else cleanup();
  };
}
