import { describe, it, expect } from 'vitest';
import { planJourney, planByDistanceOnly, enumerateJourneys, fmt } from '../src/core/planner.js';
import { buildLiftPlan, liftStopEvents, liftPose, doorState, LIFT_PRESETS, DEFAULT_SCHEDULE } from '../src/core/timetable.js';
import { SAFE_X, SAFE_NODES } from '../src/core/station.js';

const lifts = () => JSON.parse(JSON.stringify(DEFAULT_SCHEDULE.lifts));

function baseArgs(over = {}) {
  return {
    startTime: 0,
    startDeck: 0,
    startNode: 'center',
    goalDeck: 3,
    goalNode: 'center',
    lifts: lifts(),
    closures: [],
    horizon: 300,
    ...over,
  };
}

describe('timetable kernel', () => {
  it('produces a closed cyclic schedule with increasing stop times', () => {
    const plan = buildLiftPlan(LIFT_PRESETS.A);
    expect(plan.cycle).toBeGreaterThan(0);
    for (let i = 1; i < plan.stops.length; i += 1) {
      expect(plan.arrive[i]).toBeGreaterThan(plan.depart[i - 1] - 1e-9);
    }
    expect(plan.arrive[0] + plan.cycle).toBeCloseTo(plan.cycle, 6);
  });

  it('has a continuous pose that only stands at a deck during dwell', () => {
    const plan = buildLiftPlan(LIFT_PRESETS.A);
    for (let t = 0; t < plan.cycle; t += 0.05) {
      const p = liftPose(plan, t);
      const atDeckPositions = [0, 4, 12];
      const near = Math.min(...atDeckPositions.map((y) => Math.abs(y - p.y)));
      if (p.atDeck) {
        expect(near).toBeLessThan(1e-6);
        const d = doorState(plan, [], p.deck, t);
        if (p.local < plan.phase) expect(d.open).toBe(false);
      } else if (near < 1e-6) {
        // exactly at the departure/arrival boundary: still a valid deck pose
        expect(p.progress < 1e-6 || p.progress > 1 - 1e-6).toBe(true);
      } else {
        const d = doorState(plan, [], p.fromDeck, t);
        expect(d.open).toBe(false);
      }
    }
  });

  it('doors only open inside the gate window and never without the platform', () => {
    const plan = buildLiftPlan(LIFT_PRESETS.A);
    const closures = [];
    for (let t = 0; t < plan.cycle * 1.2; t += 0.05) {
      const d = doorState(plan, closures, 1, t);
      if (d.open) {
        expect(d.platformAtDeck).toBe(true);
        expect(d.amount).toBeGreaterThanOrEqual(0);
        expect(t).toBeGreaterThanOrEqual(d.event.gateOpen - 1e-9);
        expect(t).toBeLessThanOrEqual(d.event.gateClose + 1e-9);
        const p = liftPose(plan, t);
        expect(p.deck).toBe(1);
        expect(Math.abs(p.y - 4)).toBeLessThan(1e-9);
      }
    }
  });

  it('a platform that is not at a deck can never be boarded there', () => {
    const plan = buildLiftPlan(LIFT_PRESETS.A);
    for (let t = 0; t < plan.cycle; t += 0.1) {
      const p = liftPose(plan, t);
      if (p.atDeck) continue;
      const d = doorState(plan, [], p.fromDeck, t);
      expect(d.open).toBe(false);
    }
  });
});

describe('planner basics', () => {
  it('finds a feasible journey and respects gate windows', () => {
    const r = planJourney(baseArgs());
    expect(r.feasible).toBe(true);
    expect(r.steps.length).toBeGreaterThan(0);
    const ride = r.steps.find((s) => s.kind === 'ride');
    expect(ride).toBeTruthy();
    const boardWait = r.steps.find((s) => s.kind === 'board_wait');
    expect(boardWait.t1).toBeCloseTo(ride.t0, 6);
    expect(r.arrival).toBeGreaterThan(r.startTime);
    // riding decks differ
    expect(ride.fromDeck).not.toBe(ride.toDeck);
  });

  it('all steps are monotone in time for a feasible journey', () => {
    const r = planJourney(baseArgs());
    let prev = r.startTime;
    for (const s of r.steps) {
      expect(s.t0).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(s.t1).toBeGreaterThanOrEqual(s.t0 - 1e-9);
      prev = s.t1;
    }
  });

  it('waiting is at a safe node and approach starts after gate open', () => {
    const r = planJourney(baseArgs());
    const wait = r.steps.find((s) => s.kind === 'wait_hold');
    if (wait) {
      expect(SAFE_NODES).toContain(wait.node);
      expect(wait.reason).toBeTruthy();
    }
    const approach = r.steps.find((s) => s.kind === 'approach');
    const ride = r.steps.find((s) => s.kind === 'ride');
    expect(approach).toBeTruthy();
    // approach begins once doors are fully open
    const plan = r.lifts.find((p) => p.id === approach.platform);
    const d = doorState(plan, r.closures, approach.deck, approach.t0);
    expect(d.open).toBe(true);
  });

  it('missed departure shifts boarding to the next cycle', () => {
    const pA = buildLiftPlan(LIFT_PRESETS.A);
    // choose a time 1s after a gate closes at deck 0, right after a departure
    const ev = liftStopEvents(pA, [], 0, pA.cycle * 2).find((e) => e.deck === 0 && e.depart > 1);
    const missAt = ev.depart + 0.2;
    const r = planJourney(baseArgs({ startTime: missAt }));
    expect(r.feasible).toBe(true);
    const ride = r.steps.find((s) => s.kind === 'ride');
    expect(ride.t0).toBeGreaterThan(missAt);
    expect(ride.t0).toBeGreaterThan(ev.depart + 1);
    expect(r.missed.length).toBeGreaterThan(0);
    expect(r.waitReasons.length).toBeGreaterThan(0);
  });

  it('distance heuristic can be slower than the earliest-arrival plan', () => {
    // Sweep start times to find a case where the nearest platform is the wrong choice.
    let sawSlower = false;
    for (let start = 0; start < 60; start += 0.5) {
      const args = baseArgs({ startTime: start });
      const best = planJourney(args);
      const dist = planByDistanceOnly(args);
      if (best.feasible && dist.feasible && best.arrival < dist.arrival - 0.5) {
        sawSlower = true;
        expect(best.arrival).toBeLessThan(dist.arrival);
        break;
      }
    }
    expect(sawSlower).toBe(true);
  });

  it('uses the other lift when the nearest one is closed', () => {
    const pA = buildLiftPlan(LIFT_PRESETS.A);
    const args = baseArgs({ startTime: 0 });
    const base = planJourney(args);
    const chosen = base.steps.find((s) => s.kind === 'ride');
    const other = chosen.platform === 'A' ? 'B' : 'A';
    const closures = [
      { liftId: chosen.platform, decks: [0, 3], from: 0, to: 45, reason: '检修封闭' },
    ];
    const r = planJourney({ ...args, closures });
    expect(r.feasible).toBe(true);
    const ride2 = r.steps.find((s) => s.kind === 'ride');
    expect(ride2.platform).not.toBe(chosen.platform);
  });

  it('reports unreachable when the goal deck service is closed for the horizon', () => {
    const closures = [{ decks: [3], from: 0, to: 600, reason: 'L3 整体服务中断' }];
    const r = planJourney(baseArgs({ closures, horizon: 120 }));
    expect(r.feasible).toBe(false);
    expect(r.diagnostics.message).toBeTruthy();
    expect(r.diagnostics.reopenAt).toBe(600);
    expect(r.steps.length).toBe(0);
  });

  it('matches the exhaustive enumeration oracle on arrival time', () => {
    for (const start of [0, 5.3, 12.7, 21.1, 33.4]) {
      for (const [s, g] of [
        [0, 3],
        [1, 2],
        [2, 0],
        [3, 1],
      ]) {
        const args = baseArgs({ startTime: start, startDeck: s, goalDeck: g, horizon: 400 });
        const r = planJourney(args);
        const all = enumerateJourneys(args, { maxRides: 2 });
        expect(all.length).toBeGreaterThan(0);
        const oracle = all[0].arrival;
        expect(r.feasible).toBe(true);
        expect(r.arrival).toBeCloseTo(oracle, 5);
      }
    }
  });

  it('never crosses the gap while the platform is not at the deck', () => {
    const r = planJourney(baseArgs());
    const plan = r.lifts.find((p) => p.id === r.steps.find((s) => s.kind === 'approach').platform);
    const board = r.steps.find((s) => s.kind === 'board_wait');
    const approach = r.steps.find((s) => s.kind === 'approach');
    // Throughout the gap crossing the platform must be at this deck and the doors open.
    for (let t = approach.t0; t <= approach.t1; t += 0.02) {
      const p = liftPose(plan, t);
      expect(p.atDeck).toBe(true);
      const d = doorState(plan, [], p.deck, t);
      expect(d.open).toBe(true);
    }
    expect(board.t0).toBeCloseTo(approach.t1, 6);
  });
});
