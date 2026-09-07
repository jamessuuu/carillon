// tools/probecheck.mjs — prove the pointer probe actually links the scope to
// the two figures on the DEPLOYED page: hovering a note must move both figure
// markers and rewrite the readout to that note's numbers.
//
//   node tools/probecheck.mjs <url>
import { chromium } from 'file:///C:/Users/admin/agentjames/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2];
if (!url) { console.error('usage: probecheck.mjs <url>'); process.exit(1); }
mkdirSync(join(process.cwd(), 'docs'), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(1200);

const read = () =>
  page.evaluate(() => ({
    interval: document.getElementById('roInterval').textContent,
    note: document.getElementById('roNote').textContent,
    intervalMarker: document.querySelector('#figIntervalField .fig-marker').style.left,
    intervalDot: document.querySelector('#figIntervalField .fig-dot').style.bottom,
    dwellMarker: document.querySelector('#figDwellField .fig-marker').style.left,
    probed: document.querySelectorAll('#plot .note.is-probed').length,
  }));

const before = await read();
const notes = await page.$$('#plot .note');
console.log(`${notes.length} notes in the scope`);

// Hover a low note and a high note; both figures must follow.
const samples = [4, 17, 30];
const seen = [];
for (const i of samples) {
  await notes[i].hover();
  await page.waitForTimeout(320);
  const s = await read();
  seen.push(s);
  console.log(
    `hover note ${String(i).padStart(2)} -> readout ${String(s.interval).padStart(4)}ms ${String(s.note).padEnd(4)}` +
    ` | interval marker ${s.intervalMarker.padEnd(8)} dot ${s.intervalDot.padEnd(8)}` +
    ` | dwell marker ${s.dwellMarker.padEnd(8)} | probed=${s.probed}`,
  );
}
await page.screenshot({ path: join(process.cwd(), 'docs', 'live-probe-1440x900.png') });

await page.mouse.move(5, 5);
await page.waitForTimeout(320);
const after = await read();
console.log(`\npointer away -> readout ${after.interval}ms ${after.note}, probed=${after.probed}`);

const distinctMarkers = new Set(seen.map((s) => s.intervalMarker)).size;
const distinctDwell = new Set(seen.map((s) => s.dwellMarker)).size;
const allProbedOne = seen.every((s) => s.probed === 1);
const revert = after.probed === 0 && after.interval === before.interval;

console.log(
  `\ninterval markers distinct: ${distinctMarkers}/${samples.length}` +
  ` | dwell markers distinct: ${distinctDwell}/${samples.length}` +
  ` | exactly-one-probed each time: ${allProbedOne} | reverts on leave: ${revert}`,
);
const ok = distinctMarkers === samples.length && distinctDwell === samples.length && allProbedOne && revert;
console.log(ok ? 'OK — the probe links the scope to both figures' : 'FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
