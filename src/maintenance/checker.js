// 维护检查器：两种实测走法 + 漏乘/误乘/换乘/过期通知核对 + 调整后复验。
// 走法一：核对角色在窗口关闭前是否真正到达（checkWindowArrival）；
// 走法二：显示错过本班后续订的那一班（rebookAfterMiss）。

import { walkDuration } from '../core/station.js';
import {
  recordsOf,
  bookingsOf,
  boardEvents,
  characters,
  positionAt,
  firstArrivalAt,
  ts,
} from './dispatch.js';
import { deadlineFor, ruleLabel } from './reconstruct.js';

const EPS = 1e-9;

/** 走法一：角色是否在窗口关闭前真正到达站台候车位。 */
export function checkWindowArrival(log, who, service) {
  const hold = `hold${service.lift}`;
  let arrivedAt = firstArrivalAt(log, who, service.deck, hold, service.depart);
  const board = boardEvents(log, who).find((b) => b.service === service.id);
  if (arrivedAt === null && board) arrivedAt = board.t;
  const rules = service.endRule ? [service.endRule] : ['inclusive', 'exclusive'];
  const okUnder = {};
  for (const r of rules) {
    okUnder[r] = arrivedAt !== null && arrivedAt <= deadlineFor(service, r) + EPS;
  }
  const deadline = service.endRule ? deadlineFor(service) : null;
  const ok = service.endRule ? okUnder[service.endRule] : Object.values(okUnder).every(Boolean);
  const margin = arrivedAt !== null && deadline !== null ? deadline - arrivedAt : null;
  let detail;
  if (arrivedAt === null) {
    detail = `${who} 的轨迹中未见到达 ${service.lift} 站台候车位（${service.id}）`;
  } else if (deadline !== null) {
    detail = ok
      ? `${who} 于 ${ts(arrivedAt)} 到达 ${service.lift} 站台候车位，窗口关闭 ${ts(
          service.gateClose
        )}（截止 ${ts(deadline)}），余量 ${ts(margin)}s → 在窗口关闭前真正到达`
      : `${who} 于 ${ts(arrivedAt)} 到达 ${service.lift} 站台候车位，窗口已于 ${ts(
          service.gateClose
        )} 关闭（截止 ${ts(deadline)}），迟到 ${ts(-margin)}s → 未在窗口关闭前到达`;
  } else {
    detail = `${who} 于 ${ts(arrivedAt)} 到达候车位；结束时刻约定未决：inclusive ${
      okUnder.inclusive ? '✔' : '✘'
    } / exclusive ${okUnder.exclusive ? '✔' : '✘'}`;
  }
  return { who, service: service.id, arrivedAt, gateClose: service.gateClose, deadline, margin, ok, okUnder, detail };
}

/** 走法二：错过本班后续订并实际登乘的那一班。 */
export function rebookAfterMiss(log, who, serviceId, services) {
  const service = services.find((s) => s.id === serviceId);
  const booked = bookingsOf(log, who).find((b) => b.service === serviceId);
  const boarded = boardEvents(log, who).find((b) => b.service === serviceId);
  if (!booked || boarded) return { who, service: serviceId, missed: false };
  const laterBookings = bookingsOf(log, who).filter((b) => b.t > booked.t && b.service !== serviceId);
  let rebooked = null;
  for (const b of laterBookings) {
    const ride = boardEvents(log, who).find((x) => x.service === b.service);
    if (ride) {
      const svc = services.find((s) => s.id === b.service);
      rebooked = {
        service: b.service,
        lift: svc?.lift,
        deck: svc?.deck,
        depart: svc?.depart,
        bookedAt: b.t,
        boardedAt: ride.t,
      };
      break;
    }
  }
  return {
    who,
    service: serviceId,
    missed: true,
    missedDepart: service?.depart,
    gateClose: service?.gateClose,
    rebooked,
    detail: rebooked
      ? `${who} 漏乘 ${serviceId}（${ts(service?.depart)} 发车）→ ${ts(rebooked.bookedAt)} 续订 ${
          rebooked.service
        }（${ts(rebooked.depart)} 发车），${ts(rebooked.boardedAt)} 完成登乘`
      : `${who} 漏乘 ${serviceId}，日志中未见后续订班`,
  };
}

/** 每条登乘记录是否落在所乘班次的窗口内（预订/轨迹核对）。 */
export function validateBoardings(log, services) {
  return recordsOf(log, 'board').map((b) => {
    const s = services.find((x) => x.id === b.service);
    if (!s) return { who: b.who, service: b.service, t: b.t, ok: false, deadline: null, detail: '未知班次' };
    const deadlineUnder = { inclusive: s.gateClose, exclusive: deadlineFor(s, 'exclusive') };
    const okUnder = {
      inclusive: b.t <= deadlineUnder.inclusive + EPS,
      exclusive: b.t <= deadlineUnder.exclusive + EPS,
    };
    if (!s.endRule) {
      return {
        who: b.who,
        service: b.service,
        t: b.t,
        ok: okUnder.inclusive && okUnder.exclusive,
        deadline: null,
        okUnder,
        deadlineUnder,
        detail: `约定未决，按两种候选核对（inclusive ${okUnder.inclusive ? '✔' : '✘'} / exclusive ${
          okUnder.exclusive ? '✔' : '✘'
        }）`,
      };
    }
    const dl = deadlineFor(s);
    const ok = b.t <= dl + EPS;
    return {
      who: b.who,
      service: b.service,
      t: b.t,
      ok,
      deadline: dl,
      okUnder,
      deadlineUnder,
      detail: ok ? `登乘 ${ts(b.t)} ≤ 截止 ${ts(dl)}` : `登乘 ${ts(b.t)} 晚于截止 ${ts(dl)}`,
    };
  });
}

/** 每条预订是否指向已知班次。 */
export function validateBookings(log, services) {
  return recordsOf(log, 'booking').map((b) => ({
    who: b.who,
    service: b.service,
    t: b.t,
    ok: services.some((s) => s.id === b.service),
  }));
}

/** 误乘：实际登乘的班次不在本人任何预订中。 */
export function detectWrongRide(log, services) {
  const out = [];
  for (const b of recordsOf(log, 'board')) {
    const mine = bookingsOf(log, b.who);
    if (mine.some((x) => x.service === b.service)) continue;
    const intended = mine.filter((x) => x.t <= b.t + EPS).pop() ?? null;
    const isvc = intended && services.find((s) => s.id === intended.service);
    const bsvc = services.find((s) => s.id === b.service);
    out.push({
      who: b.who,
      t: b.t,
      boarded: b.service,
      boardedDepart: bsvc?.depart,
      intended: intended?.service ?? null,
      intendedDepart: isvc?.depart,
      detail: `${b.who} 预订 ${intended?.service ?? '（无有效预订）'}（${
        isvc ? ts(isvc.depart) : '—'
      } 发车），实际于 ${ts(b.t)} 登上 ${b.service}（${bsvc ? ts(bsvc.depart) : '—'} 发车）`,
    });
  }
  return out;
}

/** 漏乘：有预订但从未登乘该班次。 */
export function detectMissedBookings(log, services) {
  const out = [];
  for (const bk of recordsOf(log, 'booking')) {
    const rode = recordsOf(log, 'board').some((b) => b.who === bk.who && b.service === bk.service);
    if (rode) continue;
    const svc = services.find((s) => s.id === bk.service);
    out.push({ who: bk.who, service: bk.service, depart: svc?.depart, gateClose: svc?.gateClose });
  }
  return out;
}

/** 过期通知：通知发出时角色已不在该站台候车，或早已改订。 */
export function detectStaleNotifications(log) {
  const out = [];
  for (const n of recordsOf(log, 'notify')) {
    const pos = positionAt(log, n.who, n.t);
    const mine = bookingsOf(log, n.who);
    const forService = mine.filter((b) => b.service === n.service);
    const lastFor = forService[forService.length - 1] ?? null;
    const later = mine.filter((b) => b.service !== n.service && b.t <= n.t + EPS && b.t > (lastFor?.t ?? -Infinity));
    const reasons = [];
    if (!lastFor) reasons.push(`${n.who} 没有 ${n.service} 的预订`);
    if (later.length) reasons.push(`已于 ${ts(later[later.length - 1].t)} 改订 ${later[later.length - 1].service}`);
    if (pos?.aboard && pos.aboard !== n.lift) reasons.push(`通知时已站在 ${pos.aboard} 平台车厢内`);
    else if (pos && !pos.aboard && pos.node !== `hold${n.lift}`)
      reasons.push(`通知时不在 ${n.lift} 站台候车（位于 ${pos.node}）`);
    if (reasons.length) {
      out.push({
        who: n.who,
        t: n.t,
        service: n.service,
        lift: n.lift,
        position: pos,
        reasons,
        detail: `${ts(n.t)} 发给 ${n.who} 的 ${n.lift} 站台上车通知已过期：${reasons.join('；')}`,
      });
    }
  }
  return out;
}

/** 正确换乘：离车后换乘另一平台，用时覆盖步行下限且登乘在窗口内。 */
export function verifyTransfer(log, who, services) {
  const alights = recordsOf(log, 'alight')
    .filter((r) => r.who === who)
    .sort((a, b) => a.t - b.t);
  const boards = boardEvents(log, who);
  for (const a of alights) {
    const next = boards.find((b) => b.t > a.t && b.lift !== a.lift && b.deck === a.deck);
    if (!next) continue;
    const need = walkDuration(`hold${a.lift}`, `hold${next.lift}`);
    const used = next.t - a.t;
    const svc = services.find((s) => s.id === next.service);
    const windowOk = svc
      ? svc.endRule
        ? next.t <= deadlineFor(svc) + EPS
        : ['inclusive', 'exclusive'].every((r) => next.t <= deadlineFor(svc, r) + EPS)
      : true;
    const ok = used >= need - EPS && windowOk;
    return {
      who,
      from: { lift: a.lift, deck: a.deck, t: a.t, service: a.service },
      to: { lift: next.lift, deck: next.deck, t: next.t, service: next.service },
      walkNeeded: need,
      transferTime: used,
      windowOk,
      ok,
      detail: `${who} ${a.lift}→${next.lift} 换乘用时 ${ts(used)}s（步行下限 ${ts(need)}s），登乘 ${ts(
        next.t
      )} ${windowOk ? '在窗口内' : '超出窗口'} → ${ok ? '换乘有效' : '换乘无效'}`,
    };
  }
  return null;
}

/**
 * 只调整第二班后的复验：
 * - 确认 before→after 之间只有晚点班次的时刻发生变化；
 * - 原班乘客（登乘记录全部落在未调整班次上）的预订与轨迹仍能核对；
 * - 晚点班乘客在旧表下本应违例、调整后核对通过。
 */
export function reverifyAfterAdjustment({ before, after, log }) {
  const changed = [];
  for (const s of after.services) {
    const b0 = before.services.find((x) => x.id === s.id);
    if (!b0) continue;
    if (['arrive', 'depart', 'gateOpen', 'gateClose'].some((k) => Math.abs(b0[k] - s[k]) > EPS)) {
      changed.push(s.id);
    }
  }
  const unchanged = after.services.filter((s) => !changed.includes(s.id)).map((s) => s.id);
  const checksBefore = validateBoardings(log, before.services);
  const checksAfter = validateBoardings(log, after.services);
  const findCheck = (checks, b) =>
    checks.find((c) => c.who === b.who && c.service === b.service && Math.abs(c.t - b.t) < EPS);

  const original = [];
  const adjustedPax = [];
  for (const who of characters(log)) {
    const myBoards = boardEvents(log, who);
    if (!myBoards.length) continue;
    const entry = {
      who,
      bookings: bookingsOf(log, who).map((bk) => ({ service: bk.service, changed: changed.includes(bk.service) })),
      boards: myBoards.map((b) => {
        const beforeCheck = findCheck(checksBefore, b) ?? null;
        const afterCheck = findCheck(checksAfter, b) ?? null;
        const rule = after.services.find((s) => s.id === b.service)?.endRule;
        const beforeDeadline = beforeCheck
          ? beforeCheck.deadline ?? (rule ? beforeCheck.deadlineUnder?.[rule] ?? null : null)
          : null;
        return {
          service: b.service,
          t: b.t,
          before: beforeCheck,
          after: afterCheck,
          beforeDeadline,
          afterDeadline: afterCheck?.deadline ?? null,
        };
      }),
    };
    entry.ok = entry.boards.every((x) => x.after?.ok);
    const onChanged = myBoards.some((b) => changed.includes(b.service));
    (onChanged ? adjustedPax : original).push(entry);
  }
  return {
    changed,
    unchanged,
    original,
    adjusted: adjustedPax,
    ok: changed.length > 0 && [...original, ...adjustedPax].every((e) => e.ok),
  };
}
