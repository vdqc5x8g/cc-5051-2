import { DECK_BY_ID } from './station.js';

export const GATE_MARGIN = 0.15;
export const GATE_RAMP = 0.35;

function mod(a, n) {
  return ((a % n) + n) % n;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function easeInOut(u) {
  return u * u * (3 - 2 * u);
}

export const LIFT_PRESETS = {
  A: {
    id: 'A',
    stops: [0, 1, 3],
    dwell: 5.0,
    gateDelay: 0.8,
    speed: 2.0,
    phase: 0,
  },
  B: {
    id: 'B',
    stops: [0, 2, 3],
    dwell: 6.0,
    gateDelay: 0.8,
    speed: 0.9,
    phase: 3.0,
  },
};

export const DEFAULT_SCHEDULE = {
  lifts: [LIFT_PRESETS.A, LIFT_PRESETS.B].map((l) => ({ ...l, stops: [...l.stops] })),
};

/** Precompute the closed cyclic timetable of one lift. */
export function buildLiftPlan(lift) {
  const stops = [...lift.stops];
  const n = stops.length;
  const arrive = [];
  const depart = [];
  const legs = [];
  let t = 0;
  for (let i = 0; i < n; i += 1) {
    arrive[i] = t;
    depart[i] = t + lift.dwell;
    const next = stops[(i + 1) % n];
    const leg = Math.abs(DECK_BY_ID.get(next).y - DECK_BY_ID.get(stops[i]).y) / lift.speed;
    legs[i] = leg;
    t = depart[i] + leg;
  }
  const cycle = t;
  return {
    id: lift.id,
    stops,
    dwell: lift.dwell,
    gateDelay: lift.gateDelay,
    speed: lift.speed,
    phase: mod(lift.phase, cycle),
    arrive,
    depart,
    legs,
    cycle,
  };
}

/** Time of stop index i within cycle c. */
export function stopEvent(plan, index, cycleIndex) {
  const base = plan.phase + cycleIndex * plan.cycle;
  return {
    liftId: plan.id,
    deck: plan.stops[index],
    index,
    cycleIndex,
    arrive: base + plan.arrive[index],
    depart: base + plan.depart[index],
    gateOpen: base + plan.arrive[index] + plan.gateDelay,
    gateClose: base + plan.depart[index] - plan.gateDelay,
  };
}

/** The cycle index whose stop window is closest to t. */
export function cycleIndexNear(plan, index, t) {
  const rel = t - plan.phase - plan.arrive[index];
  return Math.floor(rel / plan.cycle);
}

/**
 * All stop events of a lift that touch [from, to], with gate availability
 * resolved against service closures.
 */
export function liftStopEvents(plan, closures, from, to, onlyDeck = null) {
  if (to < from) return [];
  const out = [];
  const first = Math.floor((from - plan.phase) / plan.cycle) - 1;
  const last = Math.ceil((to - plan.phase) / plan.cycle) + 1;
  for (let c = first; c <= last; c += 1) {
    for (let i = 0; i < plan.stops.length; i += 1) {
      const ev = stopEvent(plan, i, c);
      if (ev.depart <= from + 1e-9 || ev.arrive >= to - 1e-9) continue;
      if (onlyDeck !== null && ev.deck !== onlyDeck) continue;
      const closure = closureForStop(closures, plan.id, ev.deck, ev.gateOpen, ev.gateClose);
      out.push({
        ...ev,
        open: !closure,
        closureReason: closure ? closure.reason : null,
        closure: closure ? { from: closure.from, to: closure.to, reason: closure.reason } : null,
      });
    }
  }
  out.sort((a, b) => a.arrive - b.arrive || a.liftId.localeCompare(b.liftId));
  return out;
}

export function closureForStop(closures, liftId, deck, from, to) {
  return (
    closures.find(
      (c) =>
        (!c.liftId || c.liftId === liftId) &&
        c.decks.includes(deck) &&
        c.to > from + 1e-9 &&
        c.from < to - 1e-9
    ) || null
  );
}

export function closureAt(closures, liftId, deck, t) {
  return (
    closures.find(
      (c) =>
        (!c.liftId || c.liftId === liftId) &&
        c.decks.includes(deck) &&
        c.from <= t + 1e-9 &&
        c.to > t - 1e-9
    ) || null
  );
}

/** Kinematic pose of the platform car at absolute time t. */
export function liftPose(plan, t) {
  const local = mod(t - plan.phase, plan.cycle);
  const n = plan.stops.length;
  let index = n - 1;
  let moving = false;
  for (let i = 0; i < n; i += 1) {
    const arrive = plan.arrive[i];
    const depart = plan.depart[i];
    const nextArrive = i + 1 < n ? plan.arrive[i + 1] : plan.cycle;
    if (local >= arrive && local < depart) {
      index = i;
      moving = false;
      break;
    }
    if (local >= depart && local < nextArrive) {
      index = i;
      moving = true;
      break;
    }
  }
  const fromDeck = plan.stops[index];
  const yFrom = DECK_BY_ID.get(fromDeck).y;
  if (!moving) {
    return {
      liftId: plan.id,
      y: yFrom,
      atDeck: true,
      deck: fromDeck,
      fromDeck,
      toDeck: fromDeck,
      progress: 0,
      state: 'dwell',
      direction: 'idle',
      local,
    };
  }
  const toDeck = plan.stops[(index + 1) % n];
  const yTo = DECK_BY_ID.get(toDeck).y;
  if (Math.abs(yTo - yFrom) < 1e-9) {
    return {
      liftId: plan.id,
      y: yFrom,
      atDeck: true,
      deck: fromDeck,
      fromDeck,
      toDeck,
      progress: 0,
      state: 'dwell',
      direction: 'idle',
      local,
    };
  }
  const raw = clamp((local - plan.depart[index]) / plan.legs[index], 0, 1);
  return {
    liftId: plan.id,
    y: yFrom + (yTo - yFrom) * easeInOut(raw),
    atDeck: false,
    deck: null,
    fromDeck,
    toDeck,
    progress: raw,
    state: 'moving',
    direction: yTo > yFrom ? 'up' : 'down',
    local,
  };
}

/** Door state of one lift at one deck at time t. */
export function doorState(plan, closures, deck, t) {
  const pose = liftPose(plan, t);
  if (!pose.atDeck || pose.deck !== deck) {
    return { open: false, amount: 0, platformAtDeck: false, reason: '平台不在本层', pose };
  }
  const index = plan.stops.indexOf(deck);
  const c = cycleIndexNear(plan, index, t);
  const ev = stopEvent(plan, index, c);
  const closure = closureAt(closures, plan.id, deck, t);
  const within = t >= ev.gateOpen - 1e-9 && t <= ev.gateClose + 1e-9;
  const open = within && !closure;
  let amount = 0;
  if (open) {
    amount = Math.min(
      clamp((t - ev.gateOpen) / GATE_RAMP, 0, 1),
      clamp((ev.gateClose - t) / GATE_RAMP, 0, 1)
    );
  }
  return {
    open,
    amount,
    platformAtDeck: true,
    reason: closure ? closure.reason : within ? null : t < ev.gateOpen ? '开门时间未到' : '已关门',
    event: ev,
    pose,
  };
}

export function deckServiceClosure(closures, deck, t) {
  return (
    closures.find((c) => !c.liftId && c.decks.includes(deck) && c.from <= t + 1e-9 && c.to > t - 1e-9) ||
    null
  );
}

/** Next N stop events across lifts, for the schedule panel. */
export function upcomingStopEvents(plans, closures, from, to, limit = 40) {
  const all = [];
  for (const plan of plans) all.push(...liftStopEvents(plan, closures, from, to));
  all.sort((a, b) => a.depart - b.depart);
  return all.slice(0, limit);
}
