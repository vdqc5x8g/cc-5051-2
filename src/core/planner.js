import {
  SHAFTS,
  DECKS,
  SAFE_NODES,
  SAFE_X,
  HOLD_NODE,
  PLATFORM_BY_HOLD,
  BOARD_BUFFER,
  ALIGHT_BUFFER,
  deckName,
  walkDuration,
  approachDuration,
  alightDuration,
} from './station.js';
import {
  buildLiftPlan,
  liftStopEvents,
  stopEvent,
  cycleIndexNear,
  doorState,
  liftPose,
  closureAt,
  GATE_RAMP,
} from './timetable.js';

const EPS = 1e-7;

class MinHeap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  push(x) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].time <= a[i].time) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    if (!a.length) return null;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].time < a[m].time) m = l;
        if (r < a.length && a[r].time < a[m].time) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

const stateKey = (deck, node) => `${deck}|${node}`;

export function fmt(t) {
  if (!Number.isFinite(t)) return '—';
  const sign = t < 0 ? '-' : '';
  const v = Math.abs(t);
  const m = Math.floor(v / 60);
  const s = v - m * 60;
  return `${sign}${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function walkStep(deck, from, to, t0) {
  const distance = Math.abs(SAFE_X[from] - SAFE_X[to]);
  return {
    kind: 'walk',
    deck,
    from,
    to,
    t0,
    t1: t0 + distance / 1.25,
    distance,
    condition: `${deckName(deck)} 走廊步行，始终位于安全可站区域`,
  };
}

export function boardingOptions(plan, closures, deck, t, limit) {
  const approach = approachDuration(plan.id);
  const events = liftStopEvents(plan, closures, t, limit);
  const options = [];
  const missed = [];
  for (const ev of events) {
    if (ev.deck !== deck) continue;
    if (ev.depart <= t + EPS) {
      missed.push({ ev, reason: `该班已于 ${fmt(ev.depart)} 发车` });
      continue;
    }
    if (!ev.open) {
      missed.push({ ev, reason: ev.closureReason || '电梯服务关闭' });
      continue;
    }
    const ready = Math.max(t, ev.gateOpen + GATE_RAMP);
    const bay = ready + approach;
    const deadline = ev.gateClose - BOARD_BUFFER;
    if (bay > deadline + EPS) {
      missed.push({
        ev,
        reason: `即使现在出发也要 ${fmt(bay)} 到平台，晚于 ${fmt(deadline)} 的登乘截止`,
      });
      continue;
    }
    options.push({ ev, ready, bay, approach, deadline });
  }
  return { options, missed };
}

export function rideItineraries(plan, closures, boardEv, boardIndex, tLimit) {
  const n = plan.stops.length;
  const out = [];
  for (let k = 1; k < n; k += 1) {
    const stopIndex = (boardIndex + k) % n;
    const cycleAdvance = Math.floor((boardIndex + k) / n);
    const ev = stopEvent(plan, stopIndex, boardEv.cycleIndex + cycleAdvance);
    if (ev.arrive > tLimit + EPS) continue;
    const alightStart = ev.gateOpen + GATE_RAMP;
    const holdTime = alightStart + alightDuration(plan.id);
    const blocked =
      closureAt(closures, plan.id, ev.deck, alightStart) ||
      closureAt(closures, plan.id, ev.deck, holdTime);
    const alightOk = !blocked && holdTime + ALIGHT_BUFFER <= ev.gateClose + EPS;
    out.push({ ev, stopIndex, alightStart, holdTime, alightOk, blockedBy: blocked || null });
  }
  return out;
}

/**
 * Time-dependent earliest-arrival search over safe standing states.
 * Edge costs (walk durations) are fixed, but every lift edge is available only
 * at its timetable times, so labels are arrival times and domination is valid
 * only because waiting is always possible at a safe node.
 */
export function planJourney({
  startTime,
  startDeck,
  startNode,
  goalDeck,
  goalNode,
  lifts,
  closures = [],
  horizon = 300,
}) {
  const plans = lifts.map(buildLiftPlan);
  const result = {
    feasible: false,
    startTime,
    startDeck,
    startNode,
    goalDeck,
    goalNode,
    arrival: Infinity,
    steps: [],
    waitReasons: [],
    missed: [],
    lifts: plans,
    closures: closures.map((c) => ({ ...c })),
    horizon,
    diagnostics: {},
  };
  if (!SAFE_NODES.includes(startNode) || !SAFE_NODES.includes(goalNode)) {
    result.diagnostics.message = '起点或终点不在安全可站区域，导航内核拒绝出图';
    return result;
  }
  const limit = startTime + horizon;
  const seen = new Map();
  const prev = new Map();
  const startKey = stateKey(startDeck, startNode);
  const goalKey = stateKey(goalDeck, goalNode);
  seen.set(startKey, startTime);
  const heap = new MinHeap();
  heap.push({ time: startTime, deck: startDeck, node: startNode, key: startKey });
  let reached = null;

  while (heap.size) {
    const cur = heap.pop();
    if (cur.time > (seen.get(cur.key) ?? Infinity) + 1e-9) continue;
    if (cur.time > limit) break;
    if (cur.key === goalKey) {
      reached = cur;
      break;
    }

    for (const node of SAFE_NODES) {
      if (node === cur.node) continue;
      const t1 = cur.time + walkDuration(cur.node, node);
      if (t1 > limit + EPS) continue;
      const k = stateKey(cur.deck, node);
      if (t1 < (seen.get(k) ?? Infinity) - 1e-9) {
        seen.set(k, t1);
        prev.set(k, {
          from: cur.key,
          steps: [walkStep(cur.deck, cur.node, node, cur.time)],
          deck: cur.deck,
          node,
        });
        heap.push({ time: t1, deck: cur.deck, node, key: k });
      }
    }

    const platformId = PLATFORM_BY_HOLD[cur.node];
    if (!platformId) continue;
    const plan = plans.find((p) => p.id === platformId);
    if (!plan || !plan.stops.includes(cur.deck)) continue;
    const boardIndex = plan.stops.indexOf(cur.deck);
    const { options, missed } = boardingOptions(plan, closures, cur.deck, cur.time, limit);
    for (const m of missed) {
      result.missed.push({
        platform: platformId,
        deck: cur.deck,
        depart: m.ev.depart,
        reason: m.reason,
      });
    }

    for (const option of options) {
      const { ev, ready, bay } = option;
      const boardingSteps = [];
      if (ready > cur.time + EPS) {
        boardingSteps.push({
          kind: 'wait_hold',
          deck: cur.deck,
          platform: platformId,
          node: cur.node,
          t0: cur.time,
          t1: ready,
          condition: '滞留在安全等候区（边缘线之后），平台未到层时不跨越空隙',
          reason:
            cur.time < ev.arrive
              ? `${ev.liftId} 平台 ${fmt(ev.arrive)} 到站，${fmt(ev.gateOpen)} 开门；当前在安全等候区等待`
              : `等待车门完全开启（${fmt(ev.gateOpen)}–${fmt(ev.gateClose)} 为开门区间）`,
        });
      }
      boardingSteps.push({
        kind: 'approach',
        deck: cur.deck,
        platform: platformId,
        from: cur.node,
        t0: ready,
        t1: bay,
        condition: `确认平台在本层且车门完全开启后跨越空隙；登乘截止 ${fmt(option.deadline)}`,
      });
      boardingSteps.push({
        kind: 'board_wait',
        deck: cur.deck,
        platform: platformId,
        t0: bay,
        t1: ev.depart,
        condition: `已登乘，等待 ${fmt(ev.depart)} 发车（关门 ${fmt(ev.gateClose)}）`,
      });

      for (const ride of rideItineraries(plan, closures, ev, boardIndex, limit)) {
        if (!ride.alightOk) continue;
        const steps = [
          ...boardingSteps,
          {
            kind: 'ride',
            platform: platformId,
            fromDeck: cur.deck,
            toDeck: ride.ev.deck,
            t0: ev.depart,
            t1: ride.ev.arrive,
            condition: `发车 ${fmt(ev.depart)}，到站 ${fmt(ride.ev.arrive)}；位置由升降通路内核位姿给出`,
          },
          {
            kind: 'door_wait',
            deck: ride.ev.deck,
            platform: platformId,
            t0: ride.ev.arrive,
            t1: ride.alightStart,
            condition: `已在 ${fmt(ride.ev.arrive)} 到站，等待车门开启（${fmt(
              ride.ev.gateOpen
            )}）后才可越过空隙`,
          },
          {
            kind: 'alight',
            deck: ride.ev.deck,
            platform: platformId,
            t0: ride.alightStart,
            t1: ride.holdTime,
            condition: `开门区间 ${fmt(ride.ev.gateOpen)}–${fmt(
              ride.ev.gateClose
            )}，${fmt(ride.ev.gateClose)} 前离开平台并退回安全等候区`,
          },
        ];
        const hold = HOLD_NODE[platformId];
        const k = stateKey(ride.ev.deck, hold);
        if (ride.holdTime < (seen.get(k) ?? Infinity) - 1e-9) {
          seen.set(k, ride.holdTime);
          prev.set(k, {
            from: cur.key,
            steps,
            deck: ride.ev.deck,
            node: hold,
          });
          heap.push({ time: ride.holdTime, deck: ride.ev.deck, node: hold, key: k });
        }
      }
    }
  }

  if (!reached) {
    const blocked = closures.filter((c) => c.decks.includes(goalDeck));
    result.diagnostics.message = `规划视界 ${horizon}s 内无法安全到达 ${deckName(goalDeck)}`;
    if (blocked.length) {
      const reopen = Math.min(...blocked.map((c) => c.to));
      result.diagnostics.blocked = blocked.map((c) => ({ ...c }));
      result.diagnostics.reopenAt = reopen;
      result.diagnostics.message += reopen > limit
        ? `；目的层服务暂不可达（预计 ${fmt(reopen)} 才恢复）`
        : `；可在 ${fmt(reopen)} 恢复后重新规划`;
    } else {
      result.diagnostics.message += '；平台停站未覆盖该层或班次间隔超出视界';
    }
    result.diagnostics.explored = seen.size;
    return result;
  }

  const segs = [];
  let cursor = goalKey;
  while (cursor !== startKey) {
    const link = prev.get(cursor);
    if (!link) break;
    segs.unshift(...link.steps);
    cursor = link.from;
  }
  const steps = normalizeSteps(segs);
  result.feasible = true;
  result.steps = steps;
  result.arrival = steps.length ? steps[steps.length - 1].t1 : startTime;
  result.waitReasons = steps
    .filter((s) => s.kind === 'wait_hold')
    .map((s) => ({ at: s.t0, until: s.t1, platform: s.platform, deck: s.deck, reason: s.reason }));
  result.diagnostics.explored = seen.size;
  result.diagnostics.ride = steps.find((s) => s.kind === 'ride') || null;
  const platforms = [...new Set(steps.filter((s) => s.platform).map((s) => s.platform))];
  result.diagnostics.message = `${fmt(result.arrival)} 到达 ${deckName(goalDeck)}${
    platforms.length ? `，使用 ${platforms.join('/')} 平台` : '（步行）'
  }`;
  return result;
}

function normalizeSteps(steps) {
  const out = [];
  for (const s of steps) {
    if (s.kind === 'walk' && s.distance < 1e-6) continue;
    const last = out[out.length - 1];
    if (
      s.kind === 'walk' &&
      last &&
      last.kind === 'walk' &&
      last.deck === s.deck &&
      Math.abs(last.t1 - s.t0) < 1e-9 &&
      last.to === s.from
    ) {
      out[out.length - 1] = { ...last, to: s.to, t1: s.t1, distance: last.distance + s.distance };
      continue;
    }
    out.push(s);
  }
  return out;
}

/** Baseline that only minimises walking distance, ignoring timetable times. */
export function planByDistanceOnly(args) {
  const { lifts, startDeck, goalDeck, startNode } = args;
  const serving = lifts.filter((l) => l.stops.includes(startDeck) && l.stops.includes(goalDeck));
  if (!serving.length) {
    return {
      feasible: false,
      arrival: Infinity,
      steps: [],
      waitReasons: [],
      missed: [],
      note: '没有同一平台直达两层，固定距离法无法给出路线',
      ranked: [],
      chosen: null,
      diagnostics: { message: '固定距离法失败：没有直达平台' },
    };
  }
  const ranked = serving
    .map((l) => {
      const hold = HOLD_NODE[l.id];
      const walk = Math.abs(SAFE_X[startNode] - SAFE_X[hold]);
      return { id: l.id, walk };
    })
    .sort((a, b) => a.walk - b.walk || a.id.localeCompare(b.id));
  const chosen = ranked[0];
  const plan = planJourney({ ...args, lifts: lifts.filter((l) => l.id === chosen.id) });
  return {
    ...plan,
    chosen: chosen.id,
    chosenWalk: chosen.walk,
    ranked,
    note: `固定距离法选 ${chosen.id} 平台（步行 ${chosen.walk.toFixed(1)}m，未比较到站时刻）`,
  };
}

/**
 * Independent enumeration of all journeys with at most `maxRides` lift rides.
 * Used as a small-graph reference oracle in tests.
 */
export function enumerateJourneys(args, { maxRides = 2 } = {}) {
  const plans = args.lifts.map(buildLiftPlan);
  const limit = args.startTime + args.horizon;
  const found = [];

  function walkTo(fromNode, toNode, t0) {
    if (fromNode === toNode) return { time: t0, steps: [] };
    const ws = walkStep(args.startDeck, fromNode, toNode, t0);
    return { time: ws.t1, steps: [ws] };
  }

  function dfs(deck, node, time, steps, rides, visited) {
    if (time > limit) return;
    if (deck === args.goalDeck && node === args.goalNode) {
      found.push({ steps: steps.slice(), arrival: time, rides });
      return;
    }
    if (rides >= maxRides) {
      // last chance: walk to goal on this deck
      if (deck === args.goalDeck && node !== args.goalNode) {
        const w = walkStep(deck, node, args.goalNode, time);
        found.push({ steps: [...steps, w], arrival: w.t1, rides });
      }
      return;
    }
    const visitKey = `${deck}|${node}|${rides}`;
    if (visited.has(visitKey) && visited.get(visitKey) <= time + 1e-9) return;
    visited.set(visitKey, time);

    for (const pid of Object.keys(SHAFTS)) {
      const plan = plans.find((p) => p.id === pid);
      if (!plan || !plan.stops.includes(deck)) continue;
      const hold = HOLD_NODE[pid];
      const walk = walkTo(node, hold, time);
      const atHold = walk.time;
      if (atHold > limit) continue;
      const boardIndex = plan.stops.indexOf(deck);
      const { options } = boardingOptions(plan, args.closures, deck, atHold, limit);
      for (const option of options) {
        for (const ride of rideItineraries(plan, args.closures, option.ev, boardIndex, limit)) {
          if (!ride.alightOk) continue;
          const legSteps = [];
          legSteps.push(...walk.steps);
          if (option.ready > atHold + EPS) {
            legSteps.push({
              kind: 'wait_hold',
              deck,
              platform: pid,
              node: hold,
              t0: atHold,
              t1: option.ready,
              condition: '安全等候区等待',
              reason: '等待到站/开门',
            });
          }
          legSteps.push({
            kind: 'approach',
            deck,
            platform: pid,
            from: hold,
            t0: option.ready,
            t1: option.bay,
            condition: '确认开门后跨越空隙',
          });
          legSteps.push({
            kind: 'board_wait',
            deck,
            platform: pid,
            t0: option.bay,
            t1: option.ev.depart,
            condition: '车内等待发车',
          });
          legSteps.push({
            kind: 'ride',
            platform: pid,
            fromDeck: deck,
            toDeck: ride.ev.deck,
            t0: option.ev.depart,
            t1: ride.ev.arrive,
            condition: '搭乘平台',
          });
          legSteps.push({
            kind: 'alight',
            deck: ride.ev.deck,
            platform: pid,
            t0: ride.alightStart,
            t1: ride.holdTime,
            condition: '开门后离车',
          });
          const nextNode = HOLD_NODE[pid];
          dfs(ride.ev.deck, nextNode, ride.holdTime, [...steps, ...legSteps], rides + 1, visited);
        }
      }
    }
    if (deck === args.goalDeck && node !== args.goalNode) {
      const w = walkStep(deck, node, args.goalNode, time);
      found.push({ steps: [...steps, w], arrival: w.t1, rides });
    }
  }

  dfs(args.startDeck, args.startNode, args.startTime, [], 0, new Map());
  found.sort((a, b) => a.arrival - b.arrival);
  return found;
}

/** Exposed so the UI can explain which core gate covers a given step. */
export function describeGate(plans, closures, platformId, deck, t) {
  const plan = plans.find((p) => p.id === platformId) || buildLiftPlan(
    plans.find((p) => p.id === platformId) || { id: platformId, stops: [], dwell: 1, gateDelay: 0.5, speed: 1, phase: 0 }
  );
  return doorState(plan, closures, deck, t);
}
