#!/usr/bin/env tsx
/**
 * Headless scenario runner.
 *
 *   npm run sim:run -- <scenarioId> [seconds] [seed]
 *
 * Runs the scenario in Node, prints a summary table and exits 1 if the
 * navigation filter diverged (mean position error > 200 m).
 */
import { BUILTIN_SCENARIOS, SENSOR_IDS, Simulation, TICK_HZ, getScenario } from '@tracksim/sim';
import type { Snapshot } from '@tracksim/sim';

const [scenarioId = 'baseline', secondsArg, seedArg] = process.argv.slice(2);

let scenario;
try {
  scenario = getScenario(scenarioId);
} catch {
  console.error(`Unknown scenario "${scenarioId}". Available: ${BUILTIN_SCENARIOS.map((s) => s.id).join(', ')}`);
  process.exit(2);
}

const seconds = secondsArg ? Number(secondsArg) : scenario.durationS;
const seed = seedArg ? Number(seedArg) : scenario.seed;
const sim = new Simulation(scenario, { seed });
const endTick = Math.min(sim.endTick, Math.round(seconds * TICK_HZ));

let sumPosError = 0;
let maxPosError = 0;
let confirmedPeak = 0;
let decoyDrops = 0;
let confirmations = 0;
let isolationEvents = 0;
let last: Snapshot = sim.snapshot();

const t0 = performance.now();
while (sim.tick < endTick) {
  last = sim.step();
  sumPosError += last.nav.posError;
  maxPosError = Math.max(maxPosError, last.nav.posError);
  const confirmed = last.tracks.filter((t) => t.status === 'confirmed' || t.status === 'coasting').length;
  confirmedPeak = Math.max(confirmedPeak, confirmed);
  for (const e of last.events) {
    if (e.source === 'tracking' && /dropped/i.test(e.message)) {
      const contact = last.contacts.find((c) => c.kind === 'decoy' && e.message.includes(`T${extractTrackId(e.message)} `));
      if (contact) decoyDrops++;
    }
    if (e.source === 'tracking' && /confirmed/i.test(e.message)) confirmations++;
    if (e.source === 'nav' && /isolated/i.test(e.message)) isolationEvents++;
  }
}
const elapsedMs = performance.now() - t0;
const ticks = sim.tick;
const meanPosError = ticks > 0 ? sumPosError / ticks : 0;

function extractTrackId(message: string): string {
  const m = /T(\d+)/.exec(message);
  return m ? (m[1] as string) : '';
}

const pad = (s: string | number, w: number): string => String(s).padStart(w);
console.log(`\n${scenario.name}  (id ${scenario.id}, seed ${seed}, ${(ticks / TICK_HZ).toFixed(1)} s, ${ticks} ticks)\n`);
console.log(`  final position error   ${pad(last.nav.posError.toFixed(1), 8)} m   (σ ${last.nav.posSigma.toFixed(1)} m)`);
console.log(`  mean position error    ${pad(meanPosError.toFixed(1), 8)} m`);
console.log(`  max position error     ${pad(maxPosError.toFixed(1), 8)} m`);
console.log(`  heading error          ${pad((last.nav.headingError * 180 / Math.PI).toFixed(3), 8)} °`);
console.log(`  sensor isolations      ${pad(isolationEvents, 8)}`);
console.log('');
console.log('  sensor     rate   accepted  rejected  rej%   meanNIS  meanInfl  isolated');
for (const id of SENSOR_IDS) {
  const s = last.sensors.find((x) => x.id === id);
  if (!s) continue;
  const total = s.accepted + s.rejected;
  const rej = total > 0 ? ((100 * s.rejected) / total).toFixed(1) : '0.0';
  console.log(
    `  ${id.padEnd(8)} ${pad(s.rateHz, 5)}Hz ${pad(s.accepted, 9)} ${pad(s.rejected, 9)} ${pad(rej, 5)}% ${pad(s.meanNis.toFixed(2), 8)} ${pad(s.meanInfluence.toFixed(3), 9)}  ${s.isolated ? 'YES' : 'no'}`,
  );
}
console.log('');
console.log(`  track confirmations    ${pad(confirmations, 8)}`);
console.log(`  peak confirmed tracks  ${pad(confirmedPeak, 8)}`);
console.log(`  confirmed at end       ${pad(last.tracks.filter((t) => t.status === 'confirmed' || t.status === 'coasting').length, 8)}`);
console.log(`  decoy track drops      ${pad(decoyDrops, 8)}`);
console.log(`  telemetry records      ${pad(last.telemetry.records, 8)}   (${last.telemetry.meanPushMicros.toFixed(2)} µs/push mean)`);
console.log(`  compute                ${pad((elapsedMs / (ticks / 1000)).toFixed(2), 8)} ms per 1000 ticks\n`);

if (meanPosError > 200) {
  console.error('FAIL: navigation filter diverged (mean position error > 200 m)');
  process.exit(1);
}
