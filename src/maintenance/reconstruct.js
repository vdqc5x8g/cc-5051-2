// 班次重建器：用真实调度数据还原旧版班次样例。
// - 传感器观测与旧表不一致 → 记为临时晚点调整（只调整该班，不动其他班次）；
// - 轨迹能唯一判定「结束时刻是否仍可登车」→ 自动还原；
// - 轨迹不足 → 歧义班次，人工选择保存在 maintenance/resolutions.json 后应用；
// - 与决定性证据矛盾的人工选择会被拒绝并说明原因。

import { BOARD_BUFFER, approachDuration } from '../core/station.js';
import { recordsOf, firstArrivalAt, ts } from './dispatch.js';

export const END_RULES = ['inclusive', 'exclusive'];
export const DELAY_THRESHOLD = 0.5;
const SENSOR_TOLERANCE = 25;
const EPS = 1e-9;

/**
 * 登乘截止时刻。
 * inclusive：结束时刻仍可登车 → 截止 = 关门时刻（旧约定的一种读法）；
 * exclusive：截止 = 关门 − BOARD_BUFFER（新内核约定）。
 */
export function deadlineFor(service, rule = service.endRule) {
  const r = rule ?? 'exclusive';
  return r === 'inclusive' ? service.gateClose : service.gateClose - BOARD_BUFFER;
}

export function ruleLabel(rule) {
  return rule === 'inclusive' ? '结束时刻仍可登车' : '结束时刻不可登车（关门 − 缓冲）';
}

const round3 = (x) => Math.round(x * 1000) / 1000;

function nearest(records, t) {
  let best = null;
  for (const r of records) {
    const d = Math.abs(r.t - t);
    if (d <= SENSOR_TOLERANCE && (best === null || d < best.d)) best = { r, d };
  }
  return best ? best.r : null;
}

function inferEndRule(leg, times, log, evidence) {
  const boards = recordsOf(log, 'board').filter((r) => r.service === leg.id);
  const bookings = recordsOf(log, 'booking').filter((r) => r.service === leg.id);
  const dlExclusive = times.gateClose - BOARD_BUFFER;
  let inclusiveVotes = 0;
  let exclusiveVotes = 0;
  let conflicts = 0;

  for (const b of boards) {
    if (b.t <= dlExclusive + EPS) {
      evidence.push(
        `${b.who} 于 ${ts(b.t)} 完成登乘（≤ 缓冲截止 ${ts(dlExclusive)}）：两种约定均可解释`
      );
    } else if (b.t <= times.gateClose + EPS) {
      inclusiveVotes += 1;
      evidence.push(
        `${b.who} 于 ${ts(b.t)} 完成登乘（晚于缓冲截止 ${ts(dlExclusive)}，不晚于关门 ${ts(
          times.gateClose
        )}）：仅「结束时刻仍可登车」成立`
      );
    } else {
      conflicts += 1;
      evidence.push(`${b.who} 于 ${ts(b.t)} 完成登乘，晚于关门 ${ts(times.gateClose)}：两种约定均矛盾`);
    }
  }

  // 决定性漏乘：预订本班、在「缓冲截止之后、关门之前」到达候车却未能登乘，
  // 随后改订 → 只有「结束时刻不可登车」能解释。
  for (const bk of bookings) {
    if (boards.some((b) => b.who === bk.who)) continue;
    const ta = firstArrivalAt(log, bk.who, leg.deck, `hold${leg.lift}`, times.gateClose);
    if (ta === null) continue;
    const aboardBy = ta + approachDuration(leg.lift);
    if (aboardBy > dlExclusive + EPS && aboardBy <= times.gateClose + EPS) {
      exclusiveVotes += 1;
      evidence.push(
        `${bk.who} 预订本班并于 ${ts(ta)} 到达候车（登乘完成需 ${ts(aboardBy)}）：` +
          `在「仍可登车」约定下本应赶上，实际漏乘 → 仅「关门 − 缓冲」成立`
      );
    }
  }

  if (conflicts > 0 || (inclusiveVotes > 0 && exclusiveVotes > 0)) {
    evidence.push('轨迹证据相互矛盾，需人工裁定');
    return { endRule: null, status: 'ambiguous', conflict: true };
  }
  if (inclusiveVotes > 0) return { endRule: 'inclusive', status: 'auto', conflict: false };
  if (exclusiveVotes > 0) return { endRule: 'exclusive', status: 'auto', conflict: false };
  if (!boards.length && !bookings.length) {
    evidence.push('无轨迹证据，结束时刻约定无法从数据判定');
  } else {
    evidence.push('轨迹未触及登乘边界，两种约定均与证据相容');
  }
  return { endRule: null, status: 'ambiguous', conflict: false };
}

/**
 * 从旧版时刻表 + 真实调度数据重建班次样例。
 * applyAdjustments=false 时保留旧表时刻（作为「调整前」对照基线）。
 */
export function reconstructSchedule({ legacy, log, resolutions = {}, applyAdjustments = true }) {
  const arrives = recordsOf(log, 'arrive');
  const departs = recordsOf(log, 'depart');
  const applied = [];
  const rejected = [];
  const unresolved = [];

  const services = legacy.services.map((leg) => {
    const evidence = [];

    // —— 1. 传感器核对到发时刻；一致偏差 → 临时晚点调整（仅本班）——
    const arrObs = nearest(
      arrives.filter((r) => r.lift === leg.lift && r.deck === leg.deck),
      leg.arrive
    );
    const depObs = nearest(
      departs.filter((r) => r.lift === leg.lift && r.deck === leg.deck),
      leg.depart
    );
    const deltaArrive = arrObs ? round3(arrObs.t - leg.arrive) : 0;
    const deltaDepart = depObs ? round3(depObs.t - leg.depart) : 0;
    const observed = Boolean(arrObs || depObs);
    const delayed =
      observed &&
      (Math.abs(deltaArrive) >= DELAY_THRESHOLD || Math.abs(deltaDepart) >= DELAY_THRESHOLD);
    const shift = delayed ? deltaArrive || deltaDepart : 0;
    let adjustment = null;
    if (delayed) {
      adjustment = {
        shift,
        reason:
          `临时晚点 ${ts(shift)}s：传感器观测到站 ${ts(leg.arrive + shift)} / 发车 ${ts(
            leg.depart + shift
          )}，旧表 ${ts(leg.arrive)} / ${ts(leg.depart)}；只调整本班`,
      };
      evidence.push(adjustment.reason);
    } else if (observed) {
      evidence.push(`传感器确认到发时刻与旧表一致（${ts(leg.arrive)} / ${ts(leg.depart)}）`);
    } else {
      evidence.push('无传感器观测，沿用旧表时刻');
    }
    const shiftT = applyAdjustments && delayed ? shift : 0;
    const times = {
      arrive: round3(leg.arrive + shiftT),
      depart: round3(leg.depart + shiftT),
      gateOpen: round3(leg.gateOpen + shiftT),
      gateClose: round3(leg.gateClose + shiftT),
    };

    // —— 2. 轨迹证据判定结束时刻约定 ——
    const inferred = inferEndRule(leg, times, log, evidence);
    let { endRule, status } = inferred;

    // —— 3. 应用人工选择（可保存）；与决定性证据矛盾的选择被拒绝 ——
    const res = resolutions[leg.id];
    if (res && res.endRule) {
      const contradicts =
        inferred.conflict ||
        (inferred.status === 'auto' && inferred.endRule && inferred.endRule !== res.endRule);
      if (contradicts) {
        rejected.push({
          service: leg.id,
          endRule: res.endRule,
          reason: `与轨迹证据矛盾（证据指向 ${inferred.endRule ? ruleLabel(inferred.endRule) : '冲突'}）`,
        });
      } else if (status === 'ambiguous') {
        endRule = res.endRule;
        status = 'manual';
        applied.push({ service: leg.id, endRule: res.endRule, note: res.note ?? null });
        evidence.push(`人工选择：${ruleLabel(res.endRule)}${res.note ? `（${res.note}）` : ''}`);
      }
    }
    if (status === 'ambiguous') unresolved.push(leg.id);

    return {
      id: leg.id,
      lift: leg.lift,
      deck: leg.deck,
      legacy: { arrive: leg.arrive, depart: leg.depart, gateOpen: leg.gateOpen, gateClose: leg.gateClose },
      ...times,
      observed,
      adjustment,
      endRule,
      status,
      evidence,
      candidates: status === 'ambiguous' ? [...END_RULES] : undefined,
    };
  });

  return {
    services,
    adjustments: services.filter((s) => s.adjustment).map((s) => ({ service: s.id, ...s.adjustment })),
    unresolved,
    applied,
    rejected,
  };
}
