import {
  SHAFTS,
  SAFE_X,
  HOLD_NODE,
  PLATFORM_BY_HOLD,
  DECK_BY_ID,
  deckLabel,
  deckName,
  isSafeNode,
} from './station.js';
import {
  buildLiftPlan,
  doorState,
  liftPose,
  closureAt,
} from './timetable.js';
import { planJourney, fmt } from './planner.js';

const STEP_LABEL = {
  walk: '步行',
  wait_hold: '安全区等待',
  approach: '跨越空隙登乘',
  board_wait: '车内待发',
  ride: '搭乘平台',
  door_wait: '车内待开门',
  alight: '开门离车',
};

export const RIDE_SPEED_OPTIONS = [0.5, 1, 2, 4, 8];

/**
 * Follower executes the planned timeline against the same kernel clock that
 * animates the scene. It never invents a position: every frame is a pure
 * function of (plan, kernel time). Before it crosses the gap or leaves the car
 * it re-checks the live door state and refuses / re-plans if the condition is
 * not actually satisfied.
 */
export class Follower {
  constructor({ startTime = 0, startDeck = 0, goalDeck = 3, schedule, closures = [], speed = 1 }) {
    this.startTime = startTime;
    this.t = startTime;
    this.startDeck = startDeck;
    this.goalDeck = goalDeck;
    this.schedule = cloneSchedule(schedule);
    this.closures = closures.map((c) => ({ ...c }));
    this.speed = speed;
    this.playing = false;
    this.log = [];
    this.replans = 0;
    this.baselineArrival = null;
    this.actualArrival = null;
    this.finalSnapshot = null;
    this.goalNode = 'center';
    this.plan = this.computePlan(startTime, startDeck, 'center');
    this.baselineArrival = this.plan.feasible ? this.plan.arrival : null;
    this.pendingReplan = false;
    this.enteredStep = 0;
  }

  get plans() {
    return this.schedule.lifts.map(buildLiftPlan);
  }

  computePlan(fromTime, fromDeck, fromNode) {
    const result = planJourney({
      startTime: fromTime,
      startDeck: fromDeck,
      startNode: fromNode,
      goalDeck: this.goalDeck,
      goalNode: this.goalNode,
      lifts: this.schedule.lifts,
      closures: this.closures,
      horizon: 360,
    });
    result._startNode = fromNode;
    result._startDeck = fromDeck;
    return result;
  }

  setSchedule(schedule) {
    this.schedule = cloneSchedule(schedule);
    this.requestReplan('班次已调整，按新时刻表重新规划');
  }

  setClosures(closures) {
    this.closures = closures.map((c) => ({ ...c }));
    this.requestReplan('服务状态已变化，重新规划');
  }

  setGoal(deck) {
    if (deck === this.goalDeck) return;
    this.goalDeck = deck;
    this.requestReplan(`目的层改为 ${deckName(deck)}，重新规划`);
  }

  requestReplan(reason) {
    const loc = this.currentLocation();
    if (loc.onBoard) {
      this.pendingReplan = true;
      this.log.push({ t: this.t, kind: 'defer', text: `${reason}；当前在车内，到站离车后重算` });
      return;
    }
    this.replan(reason);
  }

  replan(reason) {
    const loc = this.currentLocation();
    const node = isSafeNode(loc.node) ? loc.node : 'center';
    this.replans += 1;
    const next = this.computePlan(this.t, loc.deck, node);
    this.plan = next;
    this.stepCursor = null;
    this.enteredStep = 0;
    this.pendingReplan = false;
    this.log.push({
      t: this.t,
      kind: 'replan',
      text: `${reason} → ${next.feasible ? `新计划 ${fmt(next.arrival)} 到达` : next.diagnostics.message}`,
    });
  }

  /** Where the follower currently is, given the committed plan & kernel clock. */
  currentLocation() {
    const plan = this.plan;
    if (!plan.feasible) {
      return { deck: plan._startDeck ?? this.startDeck, node: 'center', onBoard: false };
    }
    const step = this.stepAt(this.t);
    if (!step) {
      const last = plan.steps[plan.steps.length - 1];
      if (!last) return { deck: this.startDeck, node: 'center', onBoard: false };
      return { deck: last.deck ?? this.goalDeck, node: lastNodeOf(last), onBoard: false };
    }
    switch (step.kind) {
      case 'walk':
      case 'wait_hold':
        return { deck: step.deck, node: step.to ?? step.node, onBoard: false };
      case 'approach':
        return { deck: step.deck, node: step.from ?? HOLD_NODE[step.platform], onBoard: false };
      case 'board_wait':
        return { deck: step.deck, node: 'bay', onBoard: true };
      case 'ride':
      case 'door_wait':
        return { deck: step.deck ?? step.toDeck, node: 'bay', onBoard: true };
      case 'alight':
        return { deck: step.deck, node: HOLD_NODE[step.platform], onBoard: false };
      default:
        return { deck: this.startDeck, node: 'center', onBoard: false };
    }
  }

  stepAt(t) {
    const steps = this.plan.steps || [];
    if (!steps.length) return null;
    const idx = this.stepIndexAt(t);
    return steps[idx] ?? null;
  }

  stepIndexAt(t) {
    const steps = this.plan.steps || [];
    for (let i = 0; i < steps.length; i += 1) {
      if (t < steps[i].t1 - 1e-9) return i;
    }
    return steps.length;
  }

  tick(realDtSeconds) {
    if (!this.playing) return;
    if (!this.plan.feasible) return;
    if (this.actualArrival !== null) return;
    const dt = realDtSeconds * this.speed;
    const next = this.t + dt;
    this.advanceTo(next);
  }

  advanceTo(nextTime) {
    const plan = this.plan;
    if (!plan.feasible || !plan.steps || !plan.steps.length) {
      this.t = nextTime;
      return;
    }
    const steps = plan.steps;
    if (this.actualArrival !== null) {
      this.t = nextTime;
      return;
    }
    // Advance across scheduled boundaries. Each step's precondition is checked
    // at the instant that step begins, before any motion into it is rendered.
    let guard = 0;
    while (this.t < nextTime - 1e-9 && guard < 128) {
      guard += 1;
      const idx = this.stepIndexAt(this.t);
      if (idx >= steps.length) {
        this.finishArrival(steps);
        return;
      }
      if (idx !== this.enteredStep) {
        if (!this.confirmStep(steps[idx], steps[idx].t0)) {
          this.playing = false;
          this.replan('实时条件不满足，暂停并重算');
          return;
        }
        this.enteredStep = idx;
      }
      const step = steps[idx];
      const target = Math.min(nextTime, step.t1);
      this.t = target;
      if (!this.holdingInvariant(step)) {
        this.playing = false;
        this.replan('跨越空隙期间车门状态变化，已退回安全区附近并重算');
        return;
      }
      if (target >= step.t1 - 1e-9) {
        this.enteredStep = idx + 1;
        if (this.enteredStep >= steps.length) {
          this.finishArrival(steps);
          return;
        }
        if (this.pendingReplan) {
          const loc = this.currentLocation();
          if (!loc.onBoard) {
            this.replan('车内到站，执行挂起的重算');
            return;
          }
        }
      }
    }
    if (this.t < nextTime) this.t = nextTime;
  }

  /** Continuous invariant while the agent is outside a safe standing node. */
  holdingInvariant(step) {
    if (step.kind === 'approach' || step.kind === 'alight') {
      const plan = this.plans.find((p) => p.id === step.platform);
      const door = doorState(plan, this.closures, step.deck, this.t);
      return door.open && door.platformAtDeck;
    }
    return true;
  }

  finishArrival(steps) {
    this.t = Math.max(this.t, steps[steps.length - 1].t1);
    this.actualArrival = this.t;
    this.finalSnapshot = this.frame();
    this.playing = false;
  }

  confirmStep(step, at = this.t) {
    if (!step) return true;
    if (step.kind === 'approach') {
      const plan = this.plans.find((p) => p.id === step.platform);
      const door = doorState(plan, this.closures, step.deck, at);
      if (!door.open || !door.platformAtDeck) return false;
      return true;
    }
    if (step.kind === 'alight') {
      const plan = this.plans.find((p) => p.id === step.platform);
      const door = doorState(plan, this.closures, step.deck, at);
      if (!door.open) return false;
    }
    if (step.kind === 'ride') {
      const plan = this.plans.find((p) => p.id === step.platform);
      // Confirm at the last instant of boarding: at the exact departure
      // timestamp the car is already kinematically moving.
      const pose = liftPose(plan, at - 1e-6);
      if (!pose.atDeck || pose.deck !== step.fromDeck) return false;
    }
    return true;
  }

  agentPosition(t) {
    const steps = this.plan.steps || [];
    if (!steps.length) {
      const p = this.startPosition();
      return { ...p, safe: true, waiting: false, riding: false, deck: this.startDeck };
    }
    const plan = this.plan;
    if (!plan.feasible) return { ...this.startPosition(), safe: true, waiting: false, riding: false };
    if (t >= steps[steps.length - 1].t1 - 1e-9) {
      const last = steps[steps.length - 1];
      const node = lastNodeOf(last);
      const deck = last.deck ?? this.goalDeck;
      return {
        x: SAFE_X[node] ?? 0,
        y: DECK_BY_ID.get(deck).y,
        z: 0,
        safe: true,
        waiting: false,
        riding: false,
        deck,
        arrived: true,
        waitLabel: this.plan.feasible ? null : null,
      };
    }
    const step = this.stepAt(t) || steps[0];
    const u = Math.max(0, Math.min(1, (t - step.t0) / Math.max(1e-9, step.t1 - step.t0)));
    const deckY = DECK_BY_ID.get(step.deck ?? this.goalDeck).y;
    switch (step.kind) {
      case 'walk': {
        const x = lerp(SAFE_X[step.from], SAFE_X[step.to], u);
        return { x, y: deckY, z: 0, safe: true, waiting: false, riding: false, deck: step.deck };
      }
      case 'wait_hold': {
        const x = SAFE_X[step.node];
        return {
          x,
          y: deckY,
          z: 0,
          safe: true,
          waiting: true,
          riding: false,
          deck: step.deck,
          waitLabel: step.reason,
        };
      }
      case 'approach': {
        const s = SHAFTS[step.platform];
        const x = lerp(s.holdX, s.shaftX, u);
        return { x, y: deckY, z: 0, safe: true, waiting: false, riding: false, deck: step.deck };
      }
      case 'board_wait': {
        const s = SHAFTS[step.platform];
        return { x: s.shaftX, y: deckY, z: 0, safe: true, waiting: true, riding: false, deck: step.deck, waitLabel: '已登乘，等待发车' };
      }
      case 'ride': {
        const planK = this.plans.find((p) => p.id === step.platform);
        const pose = liftPose(planK, t);
        const s = SHAFTS[step.platform];
        return {
          x: s.shaftX,
          y: pose.y,
          z: 0,
          safe: true,
          waiting: false,
          riding: true,
          deck: pose.atDeck ? pose.deck : step.toDeck,
          waitLabel: null,
        };
      }
      case 'door_wait': {
        const planK = this.plans.find((p) => p.id === step.platform);
        const pose = liftPose(planK, t);
        const s = SHAFTS[step.platform];
        return {
          x: s.shaftX,
          y: pose.y,
          z: 0,
          safe: true,
          waiting: true,
          riding: true,
          deck: step.deck,
          waitLabel: '到站，等待开门',
        };
      }
      case 'alight': {
        const s = SHAFTS[step.platform];
        const x = lerp(s.shaftX, s.holdX, u);
        return { x, y: deckY, z: 0, safe: true, waiting: false, riding: false, deck: step.deck };
      }
      default:
        return { ...this.startPosition(), safe: true, waiting: false, riding: false };
    }
  }

  startPosition() {
    return { x: SAFE_X[this.plan._startNode || 'center'], y: DECK_BY_ID.get(this.plan._startDeck ?? this.startDeck).y, z: 0 };
  }

  routePoints() {
    const pts = [];
    const d = this.plan._startDeck ?? this.startDeck;
    const startNode = this.plan._startNode || 'center';
    pts.push({ x: SAFE_X[startNode], y: DECK_BY_ID.get(d).y, z: 0 });
    for (const s of this.plan.steps || []) {
      if (s.kind === 'walk') {
        pts.push({ x: SAFE_X[s.to], y: DECK_BY_ID.get(s.deck).y, z: 0 });
      } else if (s.kind === 'approach') {
        pts.push({ x: SHAFTS[s.platform].shaftX, y: DECK_BY_ID.get(s.deck).y, z: 0 });
      } else if (s.kind === 'ride') {
        pts.push({ x: SHAFTS[s.platform].shaftX, y: DECK_BY_ID.get(s.toDeck).y, z: 0 });
      } else if (s.kind === 'alight') {
        pts.push({ x: SHAFTS[s.platform].holdX, y: DECK_BY_ID.get(s.deck).y, z: 0 });
      }
    }
    return pts;
  }

  statusAt(t) {
    if (!this.plan.feasible) {
      return { kind: 'failed', label: '无法规划', detail: this.plan.diagnostics.message };
    }
    if (this.actualArrival !== null) {
      return { kind: 'arrived', label: '已到达', detail: `${deckLabel(this.goalDeck)}` };
    }
    const steps = this.plan.steps;
    if (!steps.length) return { kind: 'arrived', label: '原地', detail: '' };
    if (t < steps[0].t0 - 1e-9) return { kind: 'idle', label: '等待开始', detail: '' };
    const step = this.stepAt(t);
    if (!step) return { kind: 'arrived', label: '已到达', detail: '' };
    const remaining = step.t1 - t;
    let label = STEP_LABEL[step.kind] || step.kind;
    let detail = step.reason || step.condition || '';
    if (step.kind === 'wait_hold') {
      label = '安全区等待';
    }
    return { kind: step.kind, label, detail, remaining, step };
  }

  frame() {
    const t = this.t;
    const plans = this.plans;
    const platforms = plans.map((p) => {
      const pose = liftPose(p, t);
      return { ...pose };
    });
    const doors = {};
    for (const p of plans) {
      const deckStates = {};
      for (const deck of p.stops) {
        const d = doorState(p, this.closures, deck, t);
        deckStates[deck] = { open: d.open, amount: d.amount, reason: d.reason };
      }
      const current = liftPose(p, t);
      doors[p.id] = {
        open: current.atDeck ? deckStates[current.deck]?.open ?? false : false,
        amount: current.atDeck ? deckStates[current.deck]?.amount ?? 0 : 0,
        byDeck: deckStates,
      };
    }
    const agent = this.agentPosition(t);
    const status = this.statusAt(t);
    const stepIdx = this.stepIndexAt(t);
    const stepStates = (this.plan.steps || []).map((s, i) => ({
      index: i,
      kind: s.kind,
      label: STEP_LABEL[s.kind] || s.kind,
      deck: s.deck,
      platform: s.platform,
      fromDeck: s.fromDeck,
      toDeck: s.toDeck,
      t0: s.t0,
      t1: s.t1,
      condition: s.condition,
      reason: s.reason ?? null,
      state: i < stepIdx ? 'done' : i === stepIdx ? 'current' : 'upcoming',
    }));
    return {
      t,
      playing: this.playing,
      speed: this.speed,
      phaseLabel: status.label,
      status,
      agent,
      platforms,
      doors,
      steps: stepStates,
      plan: this.plan,
      route: this.routePoints(),
      actualArrival: this.actualArrival,
      plannedArrival: this.plan.feasible ? this.plan.arrival : null,
      baselineArrival: this.baselineArrival,
      deviation:
        this.actualArrival !== null && this.baselineArrival !== null
          ? this.actualArrival - this.baselineArrival
          : null,
      replans: this.replans,
      waitReasons: this.plan.waitReasons || [],
      missed: this.plan.missed || [],
    };
  }
}

function lastNodeOf(step) {
  switch (step.kind) {
    case 'walk':
      return step.to;
    case 'wait_hold':
      return step.node;
    case 'alight':
      return HOLD_NODE[step.platform];
    case 'ride':
    case 'door_wait':
      return HOLD_NODE[step.platform];
    default:
      return 'center';
  }
}

function lerp(a, b, u) {
  return a + (b - a) * u;
}

export function cloneSchedule(schedule) {
  return {
    lifts: schedule.lifts.map((l) => ({ ...l, stops: [...l.stops], phase: l.phase ?? 0 })),
  };
}
