// 维护说明生成器：把重建结果与检查器实测走法汇总成 docs/maintenance.md。
// 说明中引用自动生成的样例编号（S-EDGE-01 … S-STALE-06）。

import { LEGACY, SAMPLES, buildDispatchLog } from './samples.js';
import { reconstructSchedule, ruleLabel } from './reconstruct.js';
import {
  checkWindowArrival,
  rebookAfterMiss,
  detectWrongRide,
  detectMissedBookings,
  detectStaleNotifications,
  verifyTransfer,
  reverifyAfterAdjustment,
} from './checker.js';
import { platformView, renderPlatformView } from './platformView.js';
import { ts } from './dispatch.js';

export function runAnalysis(resolutions = {}) {
  const log = buildDispatchLog();
  const before = reconstructSchedule({ legacy: LEGACY, log, resolutions, applyAdjustments: false });
  const after = reconstructSchedule({ legacy: LEGACY, log, resolutions, applyAdjustments: true });
  const svc = (id) => after.services.find((s) => s.id === id);
  const reverify = reverifyAfterAdjustment({ before, after, log });
  const samples = {
    'S-EDGE-01': { window: checkWindowArrival(log, 'P1', svc('LG-S1')), service: svc('LG-S1') },
    'S-DELAY-02': { service: svc('LG-S2'), reverify },
    'S-MISS-03': {
      window: checkWindowArrival(log, 'P4', svc('LG-S1')),
      rebook: rebookAfterMiss(log, 'P4', 'LG-S1', after.services),
    },
    'S-WRONG-04': { wrong: detectWrongRide(log, after.services).find((w) => w.who === 'P5') },
    'S-XFER-05': { transfer: verifyTransfer(log, 'P6', after.services) },
    'S-STALE-06': { stale: detectStaleNotifications(log).find((s) => s.who === 'P7') },
  };
  const missed = detectMissedBookings(log, after.services);
  const view = platformView({ service: svc('LG-S1'), log });
  return { log, before, after, reverify, samples, missed, view };
}

const statusLabel = (s) =>
  s.status === 'auto' ? '自动（轨迹证据）' : s.status === 'manual' ? '人工选择' : '待人工裁定';

const endRuleLabel = (s) => (s.endRule ? ruleLabel(s.endRule) : '未决');

export function generateReport(analysis, resolutions = {}) {
  const { after, reverify, samples, missed, view } = analysis;
  const L = [];
  L.push('# 班次样例重建与维护检查器 · 维护说明');
  L.push('');
  L.push('> 本说明由 `npm run maintenance`（src/maintenance/cli.js report）自动生成；');
  L.push('> 数据：真实调度日志（传感器观测 + 角色轨迹 + 预订/通知）与旧版时刻表。');
  L.push('');
  L.push('## 1. 背景');
  L.push('');
  L.push(
    '旧版时刻表只记录到发与开关门时刻，**对结束时刻（关门时刻）是否仍可登车缺少显式约定**。' +
      '本次以真实调度数据重建班次样例：轨迹能唯一判定的班次自动还原；歧义班次的人工选择保存在 ' +
      '`maintenance/resolutions.json`；传感器观测到与旧表不一致的班次记为临时晚点，只调整该班。'
  );
  L.push('');
  L.push('## 2. 班次样例重建结果');
  L.push('');
  L.push('| 班次 | 站台 | 旧表到/发 | 重建到/发 | 结束时刻约定 | 还原方式 | 调整 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of after.services) {
    L.push(
      `| ${s.id} | ${s.lift}@L${s.deck} | ${ts(s.legacy.arrive)} / ${ts(s.legacy.depart)} | ${ts(
        s.arrive
      )} / ${ts(s.depart)} | ${endRuleLabel(s)} | ${statusLabel(s)} | ${
        s.adjustment ? `临时晚点 ${ts(s.adjustment.shift)}s` : '—'
      } |`
    );
  }
  L.push('');
  L.push('### 还原证据');
  for (const s of after.services) {
    L.push(`- **${s.id}**：${s.evidence.join('；')}`);
  }
  if (after.rejected.length) {
    L.push('');
    L.push('### 被拒绝的人工选择（与轨迹证据矛盾）');
    for (const r of after.rejected) L.push(`- ${r.service} → ${r.endRule}：${r.reason}`);
  }
  L.push('');
  L.push('## 3. 临时晚点与「只调整第二班」复验（样例 S-DELAY-02）');
  L.push('');
  const s2 = samples['S-DELAY-02'].service;
  L.push(
    `下一班同名平台 **${s2.id}**（${s2.lift}@L${s2.deck}）传感器观测到站 ${ts(s2.arrive)} / 发车 ${ts(
      s2.depart
    )}，旧表 ${ts(s2.legacy.arrive)} / ${ts(s2.legacy.depart)} → 临时晚点 ${ts(
      s2.adjustment.shift
    )}s。**只调整第二班**：复验确认调整集合为 [${reverify.changed.join(', ')}]，` +
      `其余班次（${reverify.unchanged.join(', ')}）时刻未变。`
  );
  L.push('');
  L.push('原班乘客（登乘记录全部落在未调整班次上）的预订与轨迹核对：');
  for (const e of reverify.original) {
    const bits = e.boards.map((b) => `登乘 ${b.service} @${ts(b.t)}（${b.after.detail}）`);
    const bk = e.bookings.map((b) => `${b.service}${b.changed ? '（已调整）' : '（时刻未变）'}`);
    const wrongRide = e.boards.some((b) => !e.bookings.some((x) => x.service === b.service))
      ? '；登乘班次与预订不符（误乘详见 S-WRONG-04）'
      : '';
    L.push(
      `- ${e.who}：预订 ${bk.join('、')}；${bits.join('；')}${wrongRide} → ${e.ok ? '✔ 核对通过' : '✘ 需复核'}`
    );
  }
  L.push('');
  L.push('晚点班乘客（旧表下本应违例，调整后核对通过）：');
  for (const e of reverify.adjusted) {
    for (const b of e.boards) {
      L.push(
        `- ${e.who}：登乘 ${b.service} @${ts(b.t)} —— 旧表截止 ${ts(b.beforeDeadline)} ✗ → 调整后截止 ${ts(
          b.afterDeadline
        )} ✔`
      );
    }
  }
  L.push('');
  L.push('## 4. 检查器实测走法');
  L.push('');
  L.push('### 走法一 · 核对角色在窗口关闭前是否真正到达');
  L.push('');
  const w1 = samples['S-EDGE-01'].window;
  const w2 = samples['S-MISS-03'].window;
  L.push(`- 边界实例（样例 S-EDGE-01）：${w1.detail}`);
  L.push(`- 反例（样例 S-MISS-03）：${w2.detail}`);
  L.push('');
  L.push('### 走法二 · 显示错过本班后续订的那一班');
  L.push('');
  L.push(`- 样例 S-MISS-03：${samples['S-MISS-03'].rebook.detail}`);
  L.push('');
  L.push('## 5. 自动生成的实例');
  L.push('');
  L.push(`- **漏乘 · S-MISS-03**：${samples['S-MISS-03'].rebook.detail}`);
  L.push(`- **误乘 · S-WRONG-04**：${samples['S-WRONG-04'].wrong.detail}`);
  L.push(`- **正确换乘 · S-XFER-05**：${samples['S-XFER-05'].transfer.detail}`);
  L.push(`- **过期通知 · S-STALE-06**：${samples['S-STALE-06'].stale.detail}`);
  L.push('');
  L.push('漏乘清单（有预订但未登乘）：');
  for (const m of missed) L.push(`- ${m.who} 漏乘 ${m.service}（${ts(m.depart)} 发车）`);
  L.push('');
  L.push('## 6. 站台视图 · 逐拍（样例 S-EDGE-01 所在班次）');
  L.push('');
  L.push('逐拍查看预约、开门和角色真正登乘的时刻：');
  L.push('');
  L.push(renderPlatformView(view));
  L.push('');
  L.push('## 7. 人工选择（可保存）');
  L.push('');
  if (after.applied.length) {
    for (const a of after.applied) {
      L.push(`- ${a.service} → ${ruleLabel(a.endRule)}${a.note ? `（${a.note}）` : ''}`);
    }
  } else {
    L.push('- 当前没有已保存的人工选择。');
  }
  L.push(
    after.unresolved.length
      ? `- 仍待裁定：${after.unresolved.join(', ')}（用 \`node src/maintenance/cli.js resolve <班次> inclusive|exclusive --note "…"\` 保存选择）`
      : '- 所有歧义班次均已裁定。'
  );
  L.push('');
  L.push('## 8. 样例索引');
  L.push('');
  for (const s of SAMPLES) L.push(`- **${s.id}** ${s.title}：${s.story}`);
  L.push('');
  return L.join('\n');
}
