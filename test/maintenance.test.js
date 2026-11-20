import { describe, it, expect } from 'vitest';
import { LEGACY, SAMPLES, buildDispatchLog } from '../src/maintenance/samples.js';
import { reconstructSchedule, deadlineFor } from '../src/maintenance/reconstruct.js';
import {
  checkWindowArrival,
  rebookAfterMiss,
  detectWrongRide,
  detectMissedBookings,
  detectStaleNotifications,
  verifyTransfer,
  reverifyAfterAdjustment,
  validateBoardings,
} from '../src/maintenance/checker.js';
import { platformView, renderPlatformView } from '../src/maintenance/platformView.js';
import { runAnalysis, generateReport } from '../src/maintenance/report.js';

const RESOLUTIONS = {
  'LG-S2': { endRule: 'inclusive', note: '与 LG-S1 同平台同型，沿用轨迹还原约定' },
  'LG-B1': { endRule: 'exclusive', note: '调度员确认 B 平台按关门 − 缓冲执行' },
  'LG-S3': { endRule: 'inclusive', note: '无轨迹证据，按线网默认约定' },
};

const svc = (rec, id) => rec.services.find((s) => s.id === id);

describe('班次样例重建（真实调度数据 → 旧版班次）', () => {
  const log = buildDispatchLog();
  const rec = reconstructSchedule({ legacy: LEGACY, log, resolutions: {} });

  it('LG-S1 由边界轨迹自动还原为「结束时刻仍可登车」', () => {
    const s = svc(rec, 'LG-S1');
    expect(s.status).toBe('auto');
    expect(s.endRule).toBe('inclusive');
    expect(s.evidence.join(' ')).toContain('104.2');
    expect(s.adjustment).toBeNull();
  });

  it('LG-S2 检测出临时晚点 +6.0s，且只调整第二班', () => {
    const s = svc(rec, 'LG-S2');
    expect(s.adjustment).not.toBeNull();
    expect(s.adjustment.shift).toBeCloseTo(6.0, 6);
    expect(s.arrive).toBeCloseTo(133.0, 6);
    expect(s.depart).toBeCloseTo(138.0, 6);
    expect(s.gateClose).toBeCloseTo(137.2, 6);
    // 其他班次时刻保持旧表
    for (const id of ['LG-S1', 'LG-B1', 'LG-S3']) {
      const x = svc(rec, id);
      expect(x.arrive).toBeCloseTo(x.legacy.arrive, 6);
      expect(x.depart).toBeCloseTo(x.legacy.depart, 6);
    }
  });

  it('无边界轨迹的班次保持歧义并进入待裁定清单', () => {
    for (const id of ['LG-S2', 'LG-B1', 'LG-S3']) {
      expect(svc(rec, id).status).toBe('ambiguous');
    }
    expect(rec.unresolved.sort()).toEqual(['LG-B1', 'LG-S2', 'LG-S3']);
  });

  it('保存的人工选择被应用；与证据矛盾的选择被拒绝', () => {
    const ok = reconstructSchedule({ legacy: LEGACY, log, resolutions: RESOLUTIONS });
    expect(ok.unresolved).toEqual([]);
    expect(svc(ok, 'LG-S2').status).toBe('manual');
    expect(svc(ok, 'LG-S2').endRule).toBe('inclusive');
    expect(svc(ok, 'LG-B1').endRule).toBe('exclusive');
    const bad = reconstructSchedule({
      legacy: LEGACY,
      log,
      resolutions: { 'LG-S1': { endRule: 'exclusive' } },
    });
    expect(bad.rejected.length).toBe(1);
    expect(bad.rejected[0].service).toBe('LG-S1');
    expect(svc(bad, 'LG-S1').endRule).toBe('inclusive');
  });
});

describe('维护检查器 · 走法一：窗口关闭前是否真正到达', () => {
  const log = buildDispatchLog();
  const rec = reconstructSchedule({ legacy: LEGACY, log, resolutions: RESOLUTIONS });

  it('S-EDGE-01：P1 在窗口关闭前到达，且恰在关门时刻完成登乘', () => {
    const r = checkWindowArrival(log, 'P1', svc(rec, 'LG-S1'));
    expect(r.ok).toBe(true);
    expect(r.arrivedAt).toBeCloseTo(102.2, 6);
    expect(r.gateClose).toBeCloseTo(104.2, 6);
    expect(r.margin).toBeCloseTo(2.0, 6);
    // 真正登乘时刻 == 关门时刻（inclusive 约定下成立）
    const board = validateBoardings(log, rec.services).find((b) => b.who === 'P1');
    expect(board.t).toBeCloseTo(104.2, 6);
    expect(board.ok).toBe(true);
  });

  it('S-MISS-03：P4 在窗口关闭后才到达', () => {
    const r = checkWindowArrival(log, 'P4', svc(rec, 'LG-S1'));
    expect(r.ok).toBe(false);
    expect(r.arrivedAt).toBeCloseTo(104.5, 6);
    expect(r.margin).toBeCloseTo(-0.3, 6);
  });
});

describe('维护检查器 · 走法二：错过本班后续订的那一班', () => {
  const log = buildDispatchLog();
  const rec = reconstructSchedule({ legacy: LEGACY, log, resolutions: RESOLUTIONS });

  it('S-MISS-03：P4 漏乘 LG-S1 后续订晚点的 LG-S2', () => {
    const r = rebookAfterMiss(log, 'P4', 'LG-S1', rec.services);
    expect(r.missed).toBe(true);
    expect(r.rebooked.service).toBe('LG-S2');
    expect(r.rebooked.depart).toBeCloseTo(138.0, 6);
    expect(r.rebooked.boardedAt).toBeCloseTo(136.0, 6);
  });

  it('漏乘清单包含 P4/LG-S1', () => {
    const missed = detectMissedBookings(log, rec.services);
    expect(missed.some((m) => m.who === 'P4' && m.service === 'LG-S1')).toBe(true);
  });
});

describe('自动生成的实例：误乘 / 正确换乘 / 过期通知', () => {
  const log = buildDispatchLog();
  const rec = reconstructSchedule({ legacy: LEGACY, log, resolutions: RESOLUTIONS });

  it('S-WRONG-04：P5 预订 LG-S2 却登上 LG-S1', () => {
    const wrong = detectWrongRide(log, rec.services);
    expect(wrong.length).toBe(1);
    expect(wrong[0].who).toBe('P5');
    expect(wrong[0].intended).toBe('LG-S2');
    expect(wrong[0].boarded).toBe('LG-S1');
  });

  it('S-XFER-05：P6 换乘用时覆盖步行下限且在窗口内', () => {
    const t = verifyTransfer(log, 'P6', rec.services);
    expect(t.ok).toBe(true);
    expect(t.transferTime).toBeGreaterThanOrEqual(t.walkNeeded - 1e-9);
    expect(t.windowOk).toBe(true);
  });

  it('S-STALE-06：P7 已站在 B 平台车厢内却收到 A 旧站台的上车通知', () => {
    const stale = detectStaleNotifications(log);
    expect(stale.length).toBe(1);
    expect(stale[0].who).toBe('P7');
    expect(stale[0].lift).toBe('A');
    expect(stale[0].position.aboard).toBe('B');
    expect(stale[0].reasons.join(' ')).toContain('改订');
  });
});

describe('只调整第二班后的复验', () => {
  const log = buildDispatchLog();
  const before = reconstructSchedule({ legacy: LEGACY, log, resolutions: RESOLUTIONS, applyAdjustments: false });
  const after = reconstructSchedule({ legacy: LEGACY, log, resolutions: RESOLUTIONS, applyAdjustments: true });
  const rv = reverifyAfterAdjustment({ before, after, log });

  it('调整集合只有 LG-S2', () => {
    expect(rv.changed).toEqual(['LG-S2']);
    expect(rv.ok).toBe(true);
  });

  it('原班乘客的预订与轨迹仍能核对', () => {
    const whos = rv.original.map((e) => e.who);
    expect(whos).toEqual(['P1', 'P5', 'P6', 'P7']);
    for (const e of rv.original) expect(e.ok).toBe(true);
  });

  it('晚点班乘客在旧表下违例、调整后通过', () => {
    const whos = rv.adjusted.map((e) => e.who);
    expect(whos).toEqual(['P4', 'P8']);
    for (const e of rv.adjusted) {
      for (const b of e.boards) {
        expect(b.before.ok).toBe(false);
        expect(b.after.ok).toBe(true);
      }
    }
  });
});

describe('站台视图 · 逐拍', () => {
  const log = buildDispatchLog();
  const rec = reconstructSchedule({ legacy: LEGACY, log, resolutions: RESOLUTIONS });
  const view = platformView({ service: svc(rec, 'LG-S1'), log });
  const text = renderPlatformView(view);

  it('汇总预约、开门和真正登乘的时刻', () => {
    expect(view.moments.gateOpen).toBeCloseTo(100.8, 6);
    expect(view.moments.boarded.map((b) => b.who)).toEqual(['P6', 'P5', 'P1']);
    expect(view.moments.reserved.length).toBeGreaterThanOrEqual(4);
    expect(text).toContain('预约');
    expect(text).toContain('真正登乘');
  });

  it('104.2 这一拍同时包含 P1 登乘与关门事件', () => {
    const tick = view.ticks.find((t) => Math.abs(t.t - 104.2) < 1e-9);
    expect(tick).toBeTruthy();
    expect(tick.events.join(' ')).toContain('P1 登乘');
    expect(tick.events.join(' ')).toContain('关门');
    expect(tick.bay).toContain('P1');
  });

  it('拍时刻单调递增，且过期通知出现在站台事件中', () => {
    for (let i = 1; i < view.ticks.length; i += 1) {
      expect(view.ticks[i].t).toBeGreaterThan(view.ticks[i - 1].t);
    }
    expect(text).toContain('通知 P7');
  });
});

describe('维护说明（自动生成）', () => {
  const analysis = runAnalysis(RESOLUTIONS);
  const doc = generateReport(analysis, RESOLUTIONS);

  it('班次样例可从真实调度数据重建', () => {
    const s2 = analysis.after.services.find((s) => s.id === 'LG-S2');
    expect(s2.arrive).toBeCloseTo(133.0, 6);
    expect(s2.depart).toBeCloseTo(138.0, 6);
    expect(analysis.reverify.changed).toEqual(['LG-S2']);
  });

  it('说明引用全部样例编号与两种实测走法', () => {
    for (const s of SAMPLES) expect(doc).toContain(s.id);
    expect(doc).toContain('窗口关闭前是否真正到达');
    expect(doc).toContain('续订');
    expect(doc).toContain('漏乘');
    expect(doc).toContain('误乘');
    expect(doc).toContain('正确换乘');
    expect(doc).toContain('站台视图');
  });
});
