import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5173/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.screenshot({ path: '/tmp/shot-initial.png' });

const info = await page.evaluate(() => {
  const s = window.__nav?.state;
  if (!s) return { ok: false };
  const f = s.follower;
  return {
    ok: true,
    feasible: f.plan.feasible,
    arrival: f.plan.arrival,
    steps: f.plan.steps.map((x) => [x.kind, +x.t0.toFixed(2), +x.t1.toFixed(2), x.platform ?? null]),
    status: document.getElementById('result-status').textContent,
    clock: document.getElementById('clock').textContent,
    stepCount: document.getElementById('steps').children.length,
    summary: document.getElementById('summary').innerText,
  };
});
console.log(JSON.stringify({ info, errors }, null, 2));
await browser.close();
