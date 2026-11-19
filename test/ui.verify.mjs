import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

const results = {};

// 1. waiting state at the hold: jump to mid-wait via the -> control
await page.evaluate(() => {
  const f = window.__nav.state.follower;
  const w = f.plan.steps.find((s) => s.kind === 'wait_hold');
  f.advanceTo((w.t0 + w.t1) / 2);
});
await page.waitForTimeout(300);
results.waiting = await page.evaluate(() => {
  const f = window.__nav.state.follower;
  const pos = f.agentPosition(f.t);
  const frame = f.frame();
  return {
    waitLabel: pos.waitLabel,
    safe: pos.safe,
    x: +pos.x.toFixed(2),
    y: +pos.y.toFixed(2),
    waitCardHidden: document.getElementById('wait-card').hidden,
    waitReason: document.getElementById('wait-reason').textContent,
    status: document.getElementById('now-kind').textContent,
  };
});
await page.screenshot({ path: '/tmp/v-waiting.png' });

// 2. riding: character must equal kernel lift pose
await page.evaluate(() => {
  const f = window.__nav.state.follower;
  const r = f.plan.steps.find((s) => s.kind === 'ride');
  f.advanceTo((r.t0 + r.t1) / 2);
});
await page.waitForTimeout(400);
results.riding = await page.evaluate(() => {
  const f = window.__nav.state.follower;
  const nav = window.__nav;
  const r = f.plan.steps.find((s) => s.kind === 'ride');
  const plan = f.plans.find((p) => p.id === r.platform);
  const frame = f.frame();
  const pose = frame.platforms.find((p) => p.liftId === r.platform);
  const mesh = nav.scene.platformGroups.get(r.platform);
  return {
    status: document.getElementById('now-kind').textContent,
    agentY: +frame.agent.y.toFixed(4),
    kernelY: +pose.y.toFixed(4),
    meshY: +mesh.position.y.toFixed(4),
    riding: frame.agent.riding,
    liftState: pose.state,
  };
});
await page.screenshot({ path: '/tmp/v-riding.png' });

// 3. arrival + deviation
await page.evaluate(() => {
  const f = window.__nav.state.follower;
  f.advanceTo(f.plan.arrival + 0.5);
});
await page.waitForTimeout(400);
results.arrival = await page.evaluate(() => ({
  dev: document.getElementById('dev-value').textContent,
  note: document.getElementById('dev-note').textContent,
  status: document.getElementById('now-kind').textContent,
}));

// 4. schedule edit drives kernel: change A speed via UI input
await page.fill('.lift-editor[data-lift="A"] input[data-k="speed"]', '0.6');
await page.dispatchEvent('.lift-editor[data-lift="A"] input[data-k="speed"]', 'change');
await page.waitForTimeout(300);
results.scheduleEdit = await page.evaluate(() => {
  const s = window.__nav.state;
  return {
    kernelSpeed: s.follower.schedule.lifts.find((l) => l.id === 'A').speed,
    cycleText: document.querySelector('.lift-editor[data-lift="A"] [data-cycle]').textContent,
    replans: s.follower.replans,
    feasible: s.follower.plan.feasible,
  };
});

// 5. goal deck assignment drives kernel + result
await page.selectOption('#goal-deck', '1');
await page.waitForTimeout(400);
results.goalL1 = await page.evaluate(() => {
  const f = window.__nav.state.follower;
  return {
    goal: f.goalDeck,
    feasible: f.plan.feasible,
    arrival: Number.isFinite(f.plan.arrival) ? +f.plan.arrival.toFixed(2) : null,
    pill: document.getElementById('result-status').textContent,
  };
});

// 6. unreachable goal: close L1 service
await page.click('.closure-row:nth-child(2) .switch input');
await page.waitForTimeout(400);
results.unreachable = await page.evaluate(() => ({
  feasible: window.__nav.state.follower.plan.feasible,
  pill: document.getElementById('result-status').textContent,
  failureShown: !document.getElementById('failure').hidden,
  failure: document.getElementById('failure').textContent,
}));
await page.screenshot({ path: '/tmp/v-unreachable.png' });

// 7. scenario buttons
for (const name of ['missed', 'tradeoff', 'unreachable', 'compare']) {
  await page.click(`[data-scenario="${name}"]`);
  await page.waitForTimeout(450);
  results[`scenario_${name}`] = await page.evaluate(() => {
    const f = window.__nav.state.follower;
    const cmp = window.__nav.state.compare;
    return {
      startTime: +f.startTime.toFixed(1),
      feasible: f.plan.feasible,
      arrival: Number.isFinite(f.plan.arrival) ? +f.plan.arrival.toFixed(2) : null,
      missed: f.plan.missed.length,
      waits: f.plan.waitReasons.length,
      distArrival: cmp.dist && Number.isFinite(cmp.dist.arrival) ? +cmp.dist.arrival.toFixed(2) : null,
      distChosen: cmp.dist?.chosen ?? null,
      enumBest: cmp.enumBest ? +cmp.enumBest.arrival.toFixed(2) : null,
    };
  });
  await page.screenshot({ path: `/tmp/v-scenario-${name}.png` });
}

results.errors = errors;
console.log(JSON.stringify(results, null, 2));
await browser.close();
