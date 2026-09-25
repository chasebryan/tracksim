#!/usr/bin/env tsx
/**
 * Records a demo video of the real HUD.
 *
 *   npm run build && npm run demo:record -- [scenarioId] [ticksPerFrame] [seed]
 *
 * Starts `vite preview`, drives the page deterministically through
 * `window.__tracksim` (pause → step N ticks → screenshot per frame), writes
 * PNG frames to out/frames/ and encodes out/tracksim-demo.mp4 with ffmpeg.
 * The video is the application itself, not a separate re-implementation.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const [scenarioId = 'full-mission', ticksPerFrameArg = '20', seedArg] = process.argv.slice(2);
const ticksPerFrame = Math.max(1, Number(ticksPerFrameArg));
const FPS = 30;
const PORT = 4173;
const URL = `http://127.0.0.1:${PORT}/?scenario=${encodeURIComponent(scenarioId)}${seedArg ? `&seed=${seedArg}` : ''}`;
const OUT = resolve('out');
const FRAMES = resolve(OUT, 'frames');
const VIDEO = resolve(OUT, 'tracksim-demo.mp4');

async function waitForServer(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`preview server did not start at ${url}`);
}

async function main(): Promise<void> {
  if (!existsSync(resolve('packages/hud/dist/index.html'))) {
    throw new Error('packages/hud/dist not found — run `npm run build` first');
  }
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });

  const server = spawn('npm', ['run', 'preview', '-w', '@tracksim/hud'], { stdio: 'ignore' });
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/`, 30_000);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(URL);
    await page.waitForFunction(() => Boolean(window.__tracksim));
    await page.evaluate(() => window.__tracksim!.ready);
    await page.evaluate(() => window.__tracksim!.pause());

    const endTick = await page.evaluate(() => {
      const snap = window.__tracksim!.snapshot();
      return snap ? Math.round(snap.durationS * 100) : 12_000;
    });
    const frames = Math.ceil(endTick / ticksPerFrame);
    console.log(`Recording ${frames} frames (${ticksPerFrame} ticks/frame, ${(frames / FPS).toFixed(1)} s at ${FPS} fps) of "${scenarioId}"`);

    for (let i = 0; i < frames; i++) {
      await page.evaluate((n) => window.__tracksim!.step(n), ticksPerFrame);
      await page.screenshot({ path: resolve(FRAMES, `frame-${String(i).padStart(5, '0')}.png`) });
      if (i % 100 === 0) console.log(`  frame ${i}/${frames}`);
    }
    await browser.close();
  } finally {
    server.kill();
  }

  const ff = spawnSync(
    'ffmpeg',
    ['-y', '-framerate', String(FPS), '-i', resolve(FRAMES, 'frame-%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', VIDEO],
    { stdio: 'inherit' },
  );
  if (ff.status !== 0) throw new Error('ffmpeg failed');
  console.log(`\nWrote ${VIDEO}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
