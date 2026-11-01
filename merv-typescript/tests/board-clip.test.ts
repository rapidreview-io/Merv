import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { transform } from 'esbuild';
import { chromium } from 'playwright-core';

test('canvas clips produce playable video with captions and release their tracks', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<div id="root" style="width:640px;height:360px"><canvas class="static" width="640" height="360"></canvas></div>',
    );
    const source = await readFile(
      new URL('../packages/ui/web/views/board-clip.ts', import.meta.url),
      'utf8',
    );
    const script = await transform(source, { loader: 'ts', format: 'iife', globalName: 'Clip' });
    await page.addScriptTag({ content: script.code });
    const result = await page.evaluate(async () => {
      const canvas = document.querySelector('canvas')!;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#f00';
      ctx.fillRect(0, 0, 640, 360);
      const tracks: MediaStreamTrack[] = [];
      const capture = HTMLCanvasElement.prototype.captureStream;
      HTMLCanvasElement.prototype.captureStream = function (rate) {
        const stream = capture.call(this, rate);
        tracks.push(...stream.getTracks());
        return stream;
      };
      let downloaded!: (link: HTMLAnchorElement) => void;
      const download = new Promise<HTMLAnchorElement>((resolve) => {
        downloaded = resolve;
      });
      HTMLAnchorElement.prototype.click = function () {
        downloaded(this);
      };
      const stop = (
        window as unknown as {
          Clip: { recordClip(root: HTMLElement, caption: () => string): () => void };
        }
      ).Clip.recordClip(document.getElementById('root')!, () => 'Spoken words');
      await new Promise((resolve) => setTimeout(resolve, 350));
      stop();
      const link = await download;
      const blob = await (await fetch(link.href)).blob();
      const video = document.createElement('video');
      video.muted = true;
      video.src = link.href;
      await video.play();
      await new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve()));
      ctx.drawImage(video, 0, 0);
      const top = [...ctx.getImageData(20, 20, 1, 1).data];
      const caption = [...ctx.getImageData(20, 320, 1, 1).data];
      video.pause();
      return {
        size: blob.size,
        name: link.download,
        top,
        caption,
        ended: tracks.every((track) => track.readyState === 'ended'),
      };
    });
    assert.ok(result.size > 1000);
    assert.match(result.name, /^board-clip\.(webm|mp4)$/);
    assert.ok(result.top[0]! > 200);
    assert.ok(result.caption[0]! < 100);
    assert.equal(result.ended, true);
  } finally {
    await browser.close();
  }
});
