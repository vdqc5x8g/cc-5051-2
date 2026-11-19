import { StationScene } from '../scene/StationScene.js';
import { Follower, cloneSchedule } from '../core/follower.js';
import { fmt, planByDistanceOnly, enumerateJourneys, planJourney } from '../core/planner.js';
import {
  DEFAULT_SCHEDULE,
  buildLiftPlan,
  liftStopEvents,
  liftPose,
  doorState,
  closureAt,
} from '../core/timetable.js';
import {
  DECKS,
  DECK_BY_ID,
  PLATFORM_IDS,
  SHAFTS,
  SAFE_X,
  deckLabel,
  deckName,
} from '../core/station.js';

const $ = (id) => document.getElementById(id);

const state = {
  schedule: cloneSchedule(DEFAULT_SCHEDULE),
  closures: [],
  startDeck: 0,
  goalDeck: 3,
  startTime: 0,
  follower: null,
  waiting: false,
  playing: false,
  lastTs: 0,
  speed: 1,
  baseline: null,
  compare: null,
  lastNow: null,
};

const scene = new StationScene($('scene'));

/* ------------------------------------------------------------------ setup */

function populateDeckSelects() {
  for (const el of [$('start-deck'), $('goal-deck')]) {
    el.innerHTML = DECKS.map(
      (d) => `<option value="${d.id}">${d.name} · ${d.label}</option>`
    ).join('');
  }
  $('start-deck').value = String(state.startDeck);
  $('goal-deck').value = String(state.goalDeck);
}

function buildLiftEditors() {
  const root = $('lifts');
  root.innerHTML = '';
  for (const lift of state.schedule.lifts) {
    const row = document.createElement('div');
    row.className = 'lift-editor';
    row.dataset.lift = lift.id;
    row.innerHTML = `
      <div class="head">
        <strong>${lift.id} 平台</strong>
        <span class="stops">停靠 ${lift.stops.map((s) => 'L' + s).join(' → ')}（闭环）</span>
      </div>
      <div class="grid">
        <label class="field">停站时长 <span class="unit">s</span>
          <input type="number" step="0.5" min="1" data-k="dwell" value="${lift.dwell}" />
        </label>
        <label class="field">层间速度 <span class="unit">m/s</span>
          <input type="number" step="0.1" min="0.2" data-k="speed" value="${lift.speed}" />
        </label>
        <label class="field">开门延时 <span class="unit">s</span>
          <input type="number" step="0.1" min="0.2" data-k="gateDelay" value="${lift.gateDelay}" />
        </label>
        <label class="field">相位偏移 <span class="unit">s</span>
          <input type="number" step="0.5" data-k="phase" value="${lift.phase ?? 0}" />
        </label>
      </div>
      <p class="note" data-cycle></p>
    `;
    root.appendChild(row);
    const sync = () => {
      const plan = buildLiftPlan(findingLift(lift.id));
      row.querySelector('[data-cycle]').textContent =
        `闭环周期 ${plan.cycle.toFixed(1)}s · 到站 ${plan.arrive.map((t) => fmt(t)).join(' / ')}`;
    };
    sync();
    for (const input of row.querySelectorAll('input')) {
      input.addEventListener('change', () => {
        applyLiftEdit(lift.id);
      });
    }
    row._sync = sync;
  }
}

function findingLift(id) {
  return state.schedule.lifts.find((l) => l.id === id);
}

function applyLiftEdit(id) {
  const row = document.querySelector(`.lift-editor[data-lift="${id}"]`);
  const lift = findingLift(id);
  for (const input of row.querySelectorAll('input')) {
    const k = input.dataset.k;
    const v = Number(input.value);
    if (!Number.isFinite(v)) return;
    if (k === 'dwell') lift.dwell = Math.max(0.5, v);
    if (k === 'speed') lift.speed = Math.max(0.1, v);
    if (k === 'gateDelay') lift.gateDelay = Math.max(0, Math.min(lift.dwell / 2, v));
    if (k === 'phase') lift.phase = v;
  }
  buildLiftEditors();
  pushScheduleToKernel('班次参数已写回升降通路内核');
}

function buildClosures() {
  const root = $('closures');
  root.innerHTML = '';
  for (const deck of DECKS) {
    const wrap = document.createElement('label');
    wrap.className = 'closure-row';
    wrap.innerHTML = `
      <span class="decktag">${deck.name}</span>
      <span>电梯服务${deck.label}</span>
      <span class="switch"><input type="checkbox" data-deck="${deck.id}" /><span class="slider"></span></span>
      <span class="wind">视界内关闭</span>
    `;
    const input = wrap.querySelector('input');
    input.checked = state.closures.some((c) => !c.liftId && c.decks.includes(deck.id));
    input.addEventListener('change', () => {
      state.closures = state.closures.filter((c) => c.liftId || c.decks[0] !== deck.id);
      if (input.checked) {
        const from = state.follower ? state.follower.t : state.startTime;
        state.closures.push({
          decks: [deck.id],
          from: from - 0.001,
          to: from + 900,
          reason: `${deckLabel(deck.id)} 电梯服务暂停`,
        });
      }
      pushClosuresToKernel();
    });
    root.appendChild(wrap);
  }
}

/* --------------------------------------------------------- kernel driving */

function pushScheduleToKernel(reason) {
  if (!state.follower) return;
  state.follower.setSchedule(state.schedule);
  refreshBaseline();
  renderAll(`班次调整：${reason}`);
}
function pushClosuresToKernel() {
  if (!state.follower) return;
  state.follower.setClosures(state.closures);
  refreshBaseline();
  renderAll('服务状态写回升降通路内核');
}

function createFollower({ preserveTime = false } = {}) {
  const t = preserveTime && state.follower ? state.follower.t : state.startTime;
  const f = new Follower({
    startTime: state.startTime,
    startDeck: state.startDeck,
    goalDeck: state.goalDeck,
    schedule: state.schedule,
    closures: state.closures,
    speed: state.speed,
  });
  f.t = t;
  f.startTime = state.startTime;
  f.plan = f.computePlan(t, state.startDeck, 'center');
  f.baselineArrival = f.plan.feasible ? f.plan.arrival : null;
  f.playing = state.playing;
  state.follower = f;
  state.baseline = f.plan.feasible
    ? {
        arrival: f.plan.arrival,
        steps: f.plan.steps,
        route: f.routePoints(),
      }
    : null;
  state.compare = computeCompare();
}

function refreshBaseline() {
  if (!state.follower) return;
  const p = state.follower.plan;
  if (p.feasible && state.follower.actualArrival === null) {
    state.follower.baselineArrival = p.arrival;
    state.baseline = { arrival: p.arrival, steps: p.steps };
  }
  state.compare = computeCompare();
}

function computeCompare() {
  const args = {
    startTime: state.follower ? state.follower.t : state.startTime,
    startDeck: state.startDeck,
    startNode: 'center',
    goalDeck: state.goalDeck,
    goalNode: 'center',
    lifts: state.schedule.lifts,
    closures: state.closures,
    horizon: 400,
  };
  const dist = planByDistanceOnly(args);
  const enumd = enumerateJourneys(args, { maxRides: 2 });
  const perLift = state.schedule.lifts
    .filter((l) => l.stops.includes(state.startDeck) && l.stops.includes(state.goalDeck))
    .map((l) => {
      const p = planJourney({ ...args, lifts: state.schedule.lifts.filter((x) => x.id === l.id) });
      const hold = l.id === 'A' ? -3.5 : 4.1;
      return {
        id: l.id,
        walk: Math.abs(hold),
        arrival: p.feasible ? p.arrival : Infinity,
      };
    })
    .filter((x) => Number.isFinite(x.arrival));
  let closerButSlower = null;
  for (const a of perLift) {
    for (const b of perLift) {
      if (a.id === b.id) continue;
      if (a.walk < b.walk && a.arrival > b.arrival + 0.5) {
        closerButSlower = {
          near: a.id,
          nearWalk: a.walk,
          far: b.id,
          farWalk: b.walk,
          gap: a.arrival - b.arrival,
          winner: b.id,
        };
      }
    }
  }
  return {
    args,
    dist,
    enumBest: enumd[0] ?? null,
    enumCount: enumd.length,
    perLift,
    closerButSlower,
  };
}

function distanceScenarioInfo(startTime) {
  const args = {
    startTime,
    startDeck: 0,
    startNode: 'center',
    goalDeck: 3,
    goalNode: 'center',
    lifts: state.schedule.lifts,
    closures: [],
    horizon: 400,
  };
  const best = planJourney(args);
  const dist = planByDistanceOnly(args);
  const chosenPlan = planJourney({ ...args, lifts: state.schedule.lifts.filter((l) => l.id === dist.chosen) });
  return { args, best, dist, chosenPlan };
}

/* --------------------------------------------------------------- scenario */

function applyScenario(name) {
  stop();
  state.playing = false;
  state.closures = [];
  state.schedule = cloneSchedule(DEFAULT_SCHEDULE);
  state.startDeck = 0;
  state.goalDeck = 3;
  state.startTime = 0;

  if (name === 'missed') {
    // Just missed the earliest departure from the start deck; the plan must
    // wait for the next stop event instead of treating it as a zero-cost node.
    const startDeck = state.startDeck;
    let missedAt = Infinity;
    for (const lift of state.schedule.lifts) {
      const plan = buildLiftPlan(lift);
      const ev = liftStopEvents(plan, [], 0, 180).find((e) => e.deck === startDeck);
      if (ev) missedAt = Math.min(missedAt, ev.depart);
    }
    state.startTime = Number((missedAt + 0.3).toFixed(1));
  } else if (name === 'tradeoff') {
    // Find a start time where the closer platform arrives later than the far one.
    const { bestStart, detail } = findTradeoffStart();
    state.startTime = bestStart;
    state.tradeoffDetail = detail;
  } else if (name === 'unreachable') {
    state.startTime = 0;
    state.closures = [
      {
        decks: [3],
        from: -0.001,
        to: 900,
        reason: 'L3 高层电梯服务中断（计划检修）',
      },
    ];
  } else if (name === 'compare') {
    state.startTime = 0;
  }

  $('start-deck').value = String(state.startDeck);
  $('goal-deck').value = String(state.goalDeck);
  $('start-time').value = String(state.startTime);
  buildClosures();
  rebuild();
  renderAll(`验收场景：${name}`);
}

function findTradeoffStart() {
  let best = null;
  for (let t = 0; t < 120; t += 0.5) {
    const args = {
      startTime: t,
      startDeck: 0,
      startNode: 'center',
      goalDeck: 3,
      goalNode: 'center',
      lifts: state.schedule.lifts,
      closures: [],
      horizon: 400,
    };
    const bestPlan = planJourney(args);
    const choseA = planJourney({ ...args, lifts: state.schedule.lifts.filter((l) => l.id === 'A') });
    const choseB = planJourney({ ...args, lifts: state.schedule.lifts.filter((l) => l.id === 'B') });
    if (!choseA.feasible || !choseB.feasible) continue;
    // A is physically closer (3.5 m vs 4.1 m) but can arrive later.
    const gap = choseA.arrival - choseB.arrival;
    if (gap > 3 && (!best || gap > best.gap)) {
      best = {
        start: t,
        gap,
        aArrival: choseA.arrival,
        bArrival: choseB.arrival,
        best: bestPlan.arrival,
      };
    }
  }
  return { bestStart: best ? best.start : 0, detail: best };
}

/* ------------------------------------------------------------------ render */

function rebuild() {
  createFollower();
  renderAll('重新规划');
}

function renderAll(reason) {
  const f = state.follower;
  if (!f) return;
  const frame = f.frame();
  state.lastNow = frame;
  frame.ghostRoute = ghostRoutePoints();
  scene.applyFrame(frame);
  scene.render();
  renderSidebar(frame);
  renderTimeline(frame);
  renderTopbar(frame);
  updateClock(frame);
  if (reason) {
    $('diagnostics').dataset.last = reason;
  }
}

function updateClock(frame) {
  $('clock').textContent = fmt(frame.t);
}

function renderTopbar(frame) {
  const kind = $('now-kind');
  const detail = $('now-detail');
  const wc = $('wait-card');
  const st = frame.status;
  kind.textContent = st.label;
  const step = frame.steps.find((s) => s.state === 'current');
  detail.textContent = step
    ? `${step.condition || ''}${st.remaining != null ? ` · 剩余 ${st.remaining.toFixed(1)}s` : ''}`
    : st.detail || '已完成行程';
  const agent = frame.agent;
  if (agent.waitLabel) {
    wc.hidden = false;
    $('wait-reason').textContent = agent.waitLabel;
  } else {
    wc.hidden = true;
  }

  const dv = $('dev-value');
  const dn = $('dev-note');
  if (frame.actualArrival !== null) {
    const deviation = frame.actualArrival - frame.baselineArrival;
    dv.textContent = `${deviation >= 0 ? '+' : ''}${deviation.toFixed(1)}s`;
    dv.style.color = Math.abs(deviation) < 0.3 ? 'var(--green)' : Math.abs(deviation) < 5 ? 'var(--amber)' : 'var(--red)';
    dn.textContent = `实际 ${fmt(frame.actualArrival)} · 计划 ${fmt(frame.baselineArrival)}`;
  } else {
    dv.textContent = '—';
    dv.style.color = 'var(--text)';
    dn.textContent = frame.plannedArrival
      ? `计划 ${fmt(frame.plannedArrival)} 到达 ${deckName(state.goalDeck)}`
      : '尚未到达';
  }
}

function renderSidebar(frame) {
  const p = frame.plan;
  const statusPill = $('result-status');
  statusPill.className = 'pill ' + (p.feasible ? 'ok' : 'bad');
  statusPill.textContent = p.feasible ? '可达' : '不可达';

  const sum = $('summary');
  const rideStep = frame.steps.find((s) => s.kind === 'ride');
  const waitTotal = (p.steps || [])
    .filter((s) => s.kind === 'wait_hold' || s.kind === 'board_wait' || s.kind === 'door_wait')
    .reduce((a, s) => a + (s.t1 - s.t0), 0);
  const dist = state.compare?.dist;
  const enumBest = state.compare?.enumBest;
  sum.innerHTML = `
    <div class="item"><div class="k">计划到达</div><div class="v ${p.feasible ? 'good' : ''}">${p.feasible ? fmt(p.arrival) : '—'}</div></div>
    <div class="item"><div class="k">搭乘</div><div class="v">${rideStep ? `${rideStep.fromDeck}→${rideStep.toDeck} · ${rideStep.platform}平台` : p.feasible ? '纯步行' : '无'}</div></div>
    <div class="item"><div class="k">等待合计</div><div class="v warn">${waitTotal > 0 ? waitTotal.toFixed(1) + 's' : '0s'}</div></div>
    <div class="item"><div class="k">当前状态</div><div class="v">${frame.status.label}</div></div>
    <div class="item"><div class="k">固定距离法</div><div class="v ${dist && dist.feasible ? (p.feasible && dist.arrival > p.arrival + 0.5 ? 'warn' : '') : 'bad'}">${
      dist && dist.feasible ? `${fmt(dist.arrival)} · ${dist.chosen ?? ''}` : dist ? '不可行' : '—'
    }</div></div>
    <div class="item"><div class="k">穷举参考</div><div class="v good">${enumBest ? fmt(enumBest.arrival) : '无解'}</div></div>
  `;

  const fail = $('failure');
  if (!p.feasible) {
    fail.hidden = false;
    fail.textContent = p.diagnostics.message;
  } else {
    fail.hidden = true;
  }

  const list = $('steps');
  list.innerHTML = '';
  for (const s of frame.steps) {
    const li = document.createElement('li');
    li.className = `step ${s.state}`;
    const platTag = s.platform ? ` <span class="plat">[${s.platform}]</span>` : '';
    li.innerHTML = `
      <span class="idx">${s.index + 1}</span>
      <div>
        <div class="k">${s.label}${platTag}</div>
        <div class="t">${fmt(s.t0)} → ${fmt(s.t1)}${s.deck != null ? ` · L${s.deck}` : ''}${
          s.fromDeck != null ? ` · L${s.fromDeck}→L${s.toDeck}` : ''
        }</div>
        ${s.condition ? `<div class="cond">${s.condition}</div>` : ''}
        ${s.reason ? `<div class="reason">等待原因：${s.reason}</div>` : ''}
      </div>
    `;
    list.appendChild(li);
  }

  renderCompareNote(frame);
  renderTimetable(frame);
  renderDiagnostics(frame);
}

function renderCompareNote(frame) {
  const dist = state.compare?.dist;
  const enumBest = state.compare?.enumBest;
  const notes = [];
  if (dist && dist.feasible) {
    notes.push(
      `固定距离法选择 ${dist.chosen} 平台（到平台步行 ${dist.chosenWalk.toFixed(1)}m），按班次执行后 ${fmt(
        dist.arrival
      )} 到达。`
    );
  }
  if (enumBest) {
    notes.push(`穷举 ${state.compare.enumCount} 条候选路线的最早到达为 ${fmt(enumBest.arrival)}。`);
  }
  if (state.compare?.closerButSlower) {
    const c = state.compare.closerButSlower;
    notes.push(
      `距离更近的 ${c.near} 台（${c.nearWalk.toFixed(1)}m）比 ${c.far} 台（${c.farWalk.toFixed(
        1
      )}m）晚到 ${(c.gap).toFixed(1)}s，因此最早可达搜索选 ${c.winner}。`
    );
  }
  if (frame.plan.feasible) {
    notes.push(`时间相关搜索给出 ${fmt(frame.plan.arrival)}。`);
  }
  let el = $('compare-note');
  if (!el) {
    el = document.createElement('p');
    el.id = 'compare-note';
    el.className = 'note';
    $('summary').after(el);
  }
  el.textContent = notes.join(' ');
}

function renderTimetable(frame) {
  const root = $('timetable');
  root.innerHTML = '';
  const plans = state.schedule.lifts.map(buildLiftPlan);
  const from = frame.t;
  const events = [];
  for (const plan of plans) {
    for (const ev of liftStopEvents(plan, state.closures, from, from + 180)) {
      if (ev.depart <= from + 1e-6) continue;
      events.push(ev);
    }
  }
  events.sort((a, b) => a.depart - b.depart);
  for (const ev of events.slice(0, 22)) {
    const row = document.createElement('div');
    row.className = `tt-row ${ev.liftId.toLowerCase()} ${ev.open ? '' : 'closed'}`;
    row.innerHTML = `
      <span>${fmt(ev.arrive)}</span>
      <span>${ev.liftId}</span>
      <span>L${ev.deck}</span>
      <span>${ev.open ? `开门 ${fmt(ev.gateOpen)}–${fmt(ev.gateClose)}` : `<span class="reason">${ev.closureReason || '关闭'}</span>`}</span>
    `;
    root.appendChild(row);
  }
}

function renderDiagnostics(frame) {
  const p = frame.plan;
  const plans = state.schedule.lifts.map(buildLiftPlan);
  const lines = [];
  lines.push(`内核时刻 ${fmt(frame.t)}  ·  速度 ${frame.speed}×  ·  重规划 ${frame.replans} 次`);
  for (const plan of plans) {
    const pose = liftPose(plan, frame.t);
    lines.push(
      `${plan.id} 周期 ${plan.cycle.toFixed(1)}s · ${pose.atDeck ? `停在 L${pose.deck}` : `移动 L${pose.fromDeck}→L${pose.toDeck} ${(pose.progress * 100).toFixed(0)}%`}`
    );
  }
  if (p.feasible) {
    lines.push(`搜索展开 ${p.diagnostics.explored} 个安全状态`);
    lines.push(`计划 ${p.diagnostics.message}`);
  } else {
    lines.push(p.diagnostics.message);
    if (p.diagnostics.reopenAt != null) lines.push(`恢复时刻 ${fmt(p.diagnostics.reopenAt)}`);
  }
  if (frame.missed.length) {
    for (const m of frame.missed.slice(0, 4)) {
      lines.push(`错过 ${m.platform}@L${m.deck} ${fmt(m.depart)}：${m.reason}`);
    }
  }
  lines.push(`固定距离参考：${state.compare?.dist?.note ?? '—'}`);
  $('diagnostics').textContent = lines.join('\n');
}

function ghostRoutePoints() {
  const d = state.compare?.dist;
  if (!d || !d.feasible || !d.steps) return null;
  const pts = [];
  let deck = state.startDeck;
  pts.push({ x: 0, y: DECK_BY_ID.get(deck).y + 0.05, z: 0.25 });
  for (const s of d.steps) {
    if (s.kind === 'walk') {
      pts.push({ x: SAFE_X[s.to], y: DECK_BY_ID.get(s.deck).y + 0.05, z: 0.25 });
    } else if (s.kind === 'approach') {
      pts.push({ x: SHAFTS[s.platform].shaftX, y: DECK_BY_ID.get(s.deck).y + 0.05, z: 0.25 });
    } else if (s.kind === 'ride') {
      pts.push({ x: SHAFTS[s.platform].shaftX, y: DECK_BY_ID.get(s.toDeck).y + 0.05, z: 0.25 });
    } else if (s.kind === 'alight') {
      pts.push({ x: SHAFTS[s.platform].holdX, y: DECK_BY_ID.get(s.deck).y + 0.05, z: 0.25 });
    }
  }
  if (pts.length > 1) {
    pts.push({ x: 0, y: DECK_BY_ID.get(state.goalDeck).y + 0.05, z: 0.25 });
  }
  return pts;
}

function renderTimeline(frame) {
  const root = $('timeline');
  root.innerHTML = '';
  const steps = frame.steps;
  if (!steps.length) return;
  const t0 = steps[0].t0;
  const t1 = steps[steps.length - 1].t1;
  const span = Math.max(1e-6, t1 - t0);
  const track = document.createElement('div');
  track.className = 'tl-track';
  for (const s of steps) {
    const seg = document.createElement('div');
    seg.className = `tl-seg ${s.kind}`;
    seg.style.left = `${((s.t0 - t0) / span) * 100}%`;
    seg.style.width = `${Math.max(0.4, ((s.t1 - s.t0) / span) * 100)}%`;
    seg.title = `${s.label} ${fmt(s.t0)}–${fmt(s.t1)}\n${s.condition || ''}`;
    if ((s.t1 - s.t0) / span > 0.055) seg.textContent = s.label;
    track.appendChild(seg);
  }
  const cursor = document.createElement('div');
  cursor.className = 'tl-cursor';
  cursor.style.left = `${Math.min(100, Math.max(0, ((frame.t - t0) / span) * 100))}%`;
  track.appendChild(cursor);
  root.appendChild(track);
}

/* -------------------------------------------------------------------- loop */

function loop(ts) {
  requestAnimationFrame(loop);
  const f = state.follower;
  if (!f) return;
  const dt = state.lastTs ? Math.min(0.1, (ts - state.lastTs) / 1000) : 0;
  state.lastTs = ts;
  if (state.playing && f.playing) {
    f.tick(dt);
    if (!f.playing) {
      state.playing = false;
      syncPlayButton();
    }
  }
  const frame = f.frame();
  scene.applyFrame(frame);
  scene.render();
  renderTopbar(frame);
  renderTimeline(frame);
  updateClock(frame);
  if (state.playing) {
    // keep the cheaper panels fresh without rebuilding every frame
    if (!loop._tick || ts - loop._tick > 120) {
      loop._tick = ts;
      renderSidebarLite(frame);
      renderDiagnostics(frame);
    }
  }
}

function renderSidebarLite(frame) {
  // update only the volatile bits at low frequency
  const steps = frame.steps;
  const items = $('steps').children;
  steps.forEach((s, i) => {
    const el = items[i];
    if (!el) return;
    el.className = `step ${s.state}`;
  });
  const st = $('result-status');
  if (st.textContent !== (frame.plan.feasible ? '可达' : '不可达')) {
    renderSidebar(frame);
  }
}

/* ---------------------------------------------------------------- controls */

function stop() {
  state.playing = false;
  if (state.follower) state.follower.playing = false;
  syncPlayButton();
}

function play() {
  if (!state.follower) return;
  if (state.follower.actualArrival !== null) return;
  if (!state.follower.plan.feasible) return;
  state.playing = true;
  state.follower.playing = true;
  syncPlayButton();
}

function syncPlayButton() {
  const b = $('btn-play');
  b.textContent = state.playing ? '❚❚ 暂停' : '▶ 播放';
  b.classList.toggle('primary', !state.playing);
}

$('btn-play').addEventListener('click', () => {
  if (state.playing) stop();
  else play();
});

$('btn-step').addEventListener('click', () => {
  const f = state.follower;
  if (!f) return;
  stop();
  f.advanceTo(f.t + 1);
  renderAll('单步前进 1s');
});

$('btn-reset').addEventListener('click', () => {
  stop();
  state.follower = null;
  rebuild();
});

$('speed').addEventListener('change', (e) => {
  state.speed = Number(e.target.value);
  if (state.follower) state.follower.speed = state.speed;
  renderAll();
});

$('btn-apply').addEventListener('click', () => {
  stop();
  state.startDeck = Number($('start-deck').value);
  state.goalDeck = Number($('goal-deck').value);
  state.startTime = Number($('start-time').value) || 0;
  state.closures = [];
  buildClosures();
  rebuild();
});

$('btn-missed').addEventListener('click', () => {
  stop();
  const plans = state.schedule.lifts.map(buildLiftPlan);
  let next = Infinity;
  for (const plan of plans) {
    const ev = liftStopEvents(plan, state.closures, state.startTime, state.startTime + 180).find(
      (e) => e.deck === state.startDeck
    );
    if (ev) next = Math.min(next, ev.depart);
  }
  state.startTime = Number((next + 0.3).toFixed(1));
  $('start-time').value = String(state.startTime);
  rebuild();
});

$('goal-deck').addEventListener('change', () => {
  const deck = Number($('goal-deck').value);
  if (!state.follower) return;
  stop();
  state.goalDeck = deck;
  state.follower.setGoal(deck);
  state.follower.playing = false;
  refreshBaseline();
  renderAll(`目的层指派为 ${deckName(deck)}`);
});

$('start-deck').addEventListener('change', () => {
  const deck = Number($('start-deck').value);
  state.startDeck = deck;
});

for (const btn of document.querySelectorAll('[data-scenario]')) {
  btn.addEventListener('click', () => applyScenario(btn.dataset.scenario));
}

/* ------------------------------------------------------------------- boot */

populateDeckSelects();
buildLiftEditors();
buildClosures();
rebuild();
renderAll('初始化');
requestAnimationFrame(loop);

window.__nav = { state, scene, applyScenario, rebuild, planJourney };
