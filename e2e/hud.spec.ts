import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end checks against the built HUD. The page exposes `window.__tracksim`
 * (see packages/hud/src/contracts.ts) so tests drive the simulation
 * deterministically: pause, step N ticks, read the snapshot.
 */

async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__tracksim));
  await page.evaluate(() => window.__tracksim!.ready);
  await page.evaluate(() => window.__tracksim!.pause());
}

async function step(page: Page, ticks: number): Promise<void> {
  await page.evaluate((n) => window.__tracksim!.step(n), ticks);
}

test('boots, pauses and steps deterministically', async ({ page }) => {
  await ready(page);
  await step(page, 500);
  await expect(page.getByTestId('time-readout')).toHaveText('T+00:05.00');

  const cards = page.getByTestId(/^sensor-card-/);
  await expect(cards).toHaveCount(5);

  await step(page, 2500); // T+30 s
  await expect(page.getByTestId('time-readout')).toHaveText('T+00:30.00');
  const confirmed = Number(await page.getByTestId('tracks-confirmed').textContent());
  expect(confirmed).toBeGreaterThanOrEqual(1);

  const rows = page.getByTestId('terminal').locator('div');
  await expect(rows).toHaveCount(24);
  await expect(rows.last()).not.toHaveText('');
  expect(await page.getByTestId('event-log').locator('*').count()).toBeGreaterThan(0);
});

test('seeking twice to the same tick reproduces the same state', async ({ page }) => {
  await ready(page);
  const a = await page.evaluate(() => window.__tracksim!.seek(1500));
  await step(page, 700);
  const b = await page.evaluate(() => window.__tracksim!.seek(1500));
  expect(b.tick).toBe(1500);
  expect(b.nav.pos).toEqual(a.nav.pos);
  expect(b.truth.pos).toEqual(a.truth.pos);
  expect(b.tracks.map((t) => [t.id, t.status, t.pos])).toEqual(a.tracks.map((t) => [t.id, t.status, t.pos]));
});

test('injecting terrain noise isolates the sensor and it recovers', async ({ page }) => {
  await ready(page);
  await step(page, 1000);
  await expect(page.getByTestId('sensor-isolated-TERRAIN')).toBeHidden();
  await page.getByTestId('btn-inject-terrain').click();
  await step(page, 200);
  await expect(page.getByTestId('sensor-isolated-TERRAIN')).toBeVisible();
  await step(page, 2500); // disturbance lasts 20 s; well past it
  await expect(page.getByTestId('sensor-isolated-TERRAIN')).toBeHidden();
});

test('gate buttons reflect the tracker gate', async ({ page }) => {
  await ready(page);
  await expect(page.getByTestId('btn-gate-normal')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('btn-gate-strict').click();
  await step(page, 10);
  await expect(page.getByTestId('btn-gate-strict')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('btn-gate-normal')).toHaveAttribute('aria-pressed', 'false');
});

test('renders the expected HUD at T+20 s', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => window.__tracksim!.seek(2000));
  await expect(page.getByTestId('time-readout')).toHaveText('T+00:20.00');
  await expect(page).toHaveScreenshot('hud-t20.png', { maxDiffPixelRatio: 0.03 });
});
