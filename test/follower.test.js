import { describe, it, expect } from 'vitest';
import { Follower } from '../src/core/follower.js';
import { DEFAULT_SCHEDULE, buildLiftPlan, liftPose, doorState, liftStopEvents } from '../src/core/timetable.js';
import { planJourney } from '../src/core/planner.js';
import { SAFE_X, HOLD_NODE } from '../src/core/station.js';

const schedule = () => JSON.parse(JSON.stringify(DEFAULT_SCHEDULE));

function mk(over = {}) {
  return new Follower({
    startTime: 0,
    startDeck: 0,
    goalDeck: 3,
    schedule: schedule(),
    closures: [],
    speed: 1,
    ...over,
  });
}

describe('follower', () => {
  it('executes the planned timeline exactly, boundary by boundary', () => {
    const f = mk();
    f.playing = true;
    const planned = f.plan.arrival;
    let guard = 0;
    while (f.actualArrival === null && guard < 2000) {
      f.advanceTo(f.t + 0.25);
      guard += 1;
    }
    expect(f.actualArrival).not.toBeNull();
    expect(f.actualArrival).toBeCloseTo(planned, 6);
    expect(f.replans).toBe(0);
  });

  it('reports a waiting reason while at the holding area', () => {
    const f = mk();
    const wait = f.plan.steps.find((s) => s.kind === 'wait_hold');
    expect(wait).toBeTruthy();
    const mid = (wait.t0 + wait.t1) / 2;
    const pos = f.agentPosition(mid);
    expect(pos.waiting).toBe(true);
    expect(pos.safe).toBe(true);
    expect(pos.x).toBe(SAFE_X[HOLD_NODE[wait.platform]]);
    expect(pos.waitLabel).toBeTruthy();
  });

  it('never places the agent across the gap while the car is away', () => {
    const f = mk();
    f.playing = true;
    const planA = buildLiftPlan(f.schedule.lifts.find((l) => l.id === 'A'));
    const planB = buildLiftPlan(f.schedule.lifts.find((l) => l.id === 'B'));
    let guard = 0;
    while (f.actualArrival === null && guard < 4000) {
      f.advanceTo(f.t + 0.05);
      const pos = f.agentPosition(f.t);
      for (const plan of [planA, planB]) {
        const pose = liftPose(plan, f.t);
        if (Math.abs(pos.x - (plan.stops.includes(0) ? 0 : 0)) > 1e9) continue;
        if (pos.x > -4.6 && pos.x < -4.4) {
          // agent in the gap band: must be aboard a car at this deck or a car present
          expect(pose.atDeck || pos.riding).toBe(true);
        }
      }
      guard += 1;
    }
    expect(f.actualArrival).not.toBeNull();
  });

  it('is deterministic: same schedule + same dt series => same arrival', () => {
    const a = mk();
    const b = mk();
    for (let i = 0; i < 800; i += 1) {
      a.advanceTo(a.t + 0.1);
      b.advanceTo(b.t + 0.1);
      expect(a.t).toBeCloseTo(b.t, 9);
      if (a.actualArrival !== null || b.actualArrival !== null) break;
    }
    expect(a.actualArrival).toBeCloseTo(b.actualArrival, 9);
  });

  it('agent position during a ride equals the kernel car pose each frame', () => {
    const f = mk();
    const ride = f.plan.steps.find((s) => s.kind === 'ride');
    const plan = buildLiftPlan(f.schedule.lifts.find((l) => l.id === ride.platform));
    f.advanceTo(ride.t0);
    for (let t = ride.t0; t < ride.t1; t += 0.25) {
      f.advanceTo(t);
      const pos = f.agentPosition(f.t);
      const pose = liftPose(plan, f.t);
      expect(pos.riding).toBe(true);
      expect(pos.y).toBeCloseTo(pose.y, 6);
    }
    const midPose = liftPose(plan, (ride.t0 + ride.t1) / 2);
    // A slow inter-deck leg mid-point must be strictly between decks.
    if (!midPose.atDeck) {
      const decks = [0, 4, 8, 12];
      const nearest = Math.min(...decks.map((y) => Math.abs(y - midPose.y)));
      expect(nearest).toBeGreaterThan(1e-6);
    }
  });

  it('dwells at every intermediate stop instead of jumping between decks', () => {
    const base = DEFAULT_SCHEDULE.lifts.find((l) => l.id === 'B');
    const plan = buildLiftPlan({ ...base, phase: 0 });
    for (let i = 0; i < plan.stops.length; i += 1) {
      const t = plan.phase + plan.arrive[i] + 1e-3;
      const pose = liftPose(plan, t);
      expect(pose.atDeck).toBe(true);
      expect(pose.deck).toBe(plan.stops[i]);
    }
  });

  it('replans safely when the goal deck becomes unreachable mid-hold', () => {
    const f = mk();
    const wait = f.plan.steps.find((s) => s.kind === 'wait_hold');
    if (wait) f.advanceTo(wait.t0 + 0.1);
    f.setClosures([
      { decks: [3], from: f.t - 0.01, to: f.t + 900, reason: '测试中断' },
    ]);
    expect(f.plan.feasible).toBe(false);
    expect(f.plan.diagnostics.message).toBeTruthy();
    expect(f.replans).toBeGreaterThan(0);
  });

  it('re-planning defers while aboard and applies after alighting', () => {
    const f = mk();
    const ride = f.plan.steps.find((s) => s.kind === 'ride');
    f.advanceTo(ride.t0 + 0.1);
    const before = f.replans;
    f.setSchedule({
      lifts: schedule().lifts.map((l) => (l.id === 'A' ? { ...l, dwell: l.dwell + 2 } : l)),
    });
    expect(f.pendingReplan).toBe(true);
    expect(f.replans).toBe(before);
    // advance past the alight step so the follower is on a safe node again
    const alight = f.plan.steps.find((s) => s.kind === 'alight');
    f.advanceTo(alight.t1 + 0.01);
    expect(f.pendingReplan).toBe(false);
    expect(f.replans).toBeGreaterThan(before);
  });
});
