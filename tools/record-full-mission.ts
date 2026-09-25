#!/usr/bin/env tsx
/** Capture the real TrackSim HUD for a four-minute, full-mission video.
 *
 * Run `npm run build` first, then `npm run demo:full`. The PNG sequence is
 * retained in out/full-mission-frames so an interrupted capture can resume.
 * Pass `--max-frames N` to capture a short prefix when checking the setup.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

declare const window: {
  requestAnimationFrame(callback: () => void): number;
  __tracksim?: {
    ready: Promise<void>;
    pause(): void;
    step(ticks: number): Promise<unknown>;
    seek(tick: number): Promise<unknown>;
    snapshot(): { tick: number; durationS: number } | null;
  };
};

const FPS = 24;
const DURATION_S = 240;
const TOTAL_FRAMES = FPS * DURATION_S;
const END_TICK = 300 * 100;
const PORT = 4173;
const OUT = resolve('out');
const FRAMES = resolve(OUT, 'full-mission-frames');
const maxFramesArg = process.argv.indexOf('--max-frames');
const frameLimit = maxFramesArg < 0 ? TOTAL_FRAMES : Math.min(TOTAL_FRAMES, Number(process.argv[maxFramesArg + 1]));

if (!Number.isInteger(frameLimit) || frameLimit < 1) {
  throw new Error('--max-frames must be a positive integer');
}

function targetTick(frame: number): number {
  return Math.round((frame * END_TICK) / (TOTAL_FRAMES - 1));
}

function framePath(frame: number): string {
  return resolve(FRAMES, `frame-${String(frame).padStart(5, '0')}.png`);
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/`);
      if (response.ok) return;
    } catch {
      // Vite may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Vite preview did not start on port 4173');
}

async function main(): Promise<void> {
  if (!existsSync(resolve('packages/hud/dist/index.html'))) {
    throw new Error('Build the HUD first with `npm run build`');
  }
  mkdirSync(FRAMES, { recursive: true });

  let firstMissing = 0;
  while (firstMissing < frameLimit && existsSync(framePath(firstMissing))) firstMissing++;
  if (firstMissing === frameLimit) {
    console.log(`All ${frameLimit} frames already exist in ${FRAMES}`);
    return;
  }

  const server = spawn(resolve('node_modules/.bin/vite'), ['preview', '--port', String(PORT), '--strictPort'], {
    cwd: resolve('packages/hud'),
    stdio: 'inherit',
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForServer();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    page.on('pageerror', (error) => console.error(`Page error: ${error.message}`));
    await page.goto(`http://127.0.0.1:${PORT}/?scenario=full-mission`);
    await page.waitForFunction(() => Boolean(window.__tracksim));
    await page.evaluate(() => window.__tracksim!.ready);
    await page.evaluate(() => window.__tracksim!.pause());

    const snapshot = await page.evaluate(() => window.__tracksim!.snapshot());
    if (!snapshot || snapshot.durationS !== 300) {
      throw new Error(`Expected the 300-second full mission, got ${JSON.stringify(snapshot)}`);
    }

    let currentTick = snapshot.tick;
    if (firstMissing > 0) {
      const priorTick = targetTick(firstMissing - 1);
      await page.evaluate((tick) => window.__tracksim!.seek(tick), priorTick);
      currentTick = priorTick;
      console.log(`Resuming after frame ${firstMissing - 1} at tick ${priorTick}`);
    }

    console.log(`Capturing frames ${firstMissing}–${frameLimit - 1} of ${TOTAL_FRAMES} at ${FPS} fps`);
    for (let frame = firstMissing; frame < frameLimit; frame++) {
      const nextTick = targetTick(frame);
      if (nextTick > currentTick) {
        await page.evaluate((ticks) => window.__tracksim!.step(ticks), nextTick - currentTick);
        currentTick = nextTick;
      }
      // The worker reply updates the DOM; the next animation frame draws both canvases.
      await page.evaluate(() => new Promise<void>((resolve) => window.requestAnimationFrame(resolve)));
      await page.screenshot({ path: framePath(frame) });
      if ((frame + 1) % 120 === 0 || frame + 1 === frameLimit) {
        console.log(`  ${frame + 1}/${TOTAL_FRAMES} frames; sim T+${(currentTick / 100).toFixed(1)}s`);
      }
    }
    await browser.close();
    browser = undefined;
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
