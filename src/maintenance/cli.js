#!/usr/bin/env node
// 维护工具 CLI：班次样例重建 / 检查器 / 站台视图 / 人工选择 / 生成维护说明。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LEGACY, SAMPLES } from './samples.js';
import { reconstructSchedule, END_RULES, ruleLabel } from './reconstruct.js';
import { runAnalysis, generateReport } from './report.js';
import { platformView, renderPlatformView } from './platformView.js';
import { ts } from './dispatch.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESOLUTIONS_PATH = join(ROOT, 'maintenance', 'resolutions.json');
const REPORT_PATH = join(ROOT, 'docs', 'maintenance.md');

export function loadResolutions(path = RESOLUTIONS_PATH) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).services ?? {};
  } catch {
    return {};
  }
}

export function saveResolutions(services, path = RESOLUTIONS_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ updatedBy: 'maintenance-cli', services }, null, 2) + '\n'
  );
}

function printReconstruction(after) {
  console.log('班次样例重建（旧版时刻表 + 真实调度数据）');
  for (const s of after.services) {
    const adj = s.adjustment ? ` ｜ 调整：临时晚点 ${ts(s.adjustment.shift)}s` : '';
    console.log(
      `  ${s.id} ${s.lift}@L${s.deck} 到 ${ts(s.arrive)} 发 ${ts(s.depart)} ｜ ${
        s.endRule ? ruleLabel(s.endRule) : '约定未决'
      } ｜ ${s.status}${adj}`
    );
    for (const e of s.evidence) console.log(`      · ${e}`);
  }
  if (after.unresolved.length) console.log(`待人工裁定：${after.unresolved.join(', ')}`);
  if (after.rejected.length) {
    for (const r of after.rejected) console.log(`人工选择被拒绝：${r.service} → ${r.endRule}（${r.reason}）`);
  }
}

function printChecks(analysis) {
  const { samples, reverify } = analysis;
  console.log('走法一 · 核对角色在窗口关闭前是否真正到达');
  console.log(`  [S-EDGE-01] ${samples['S-EDGE-01'].window.detail}`);
  console.log(`  [S-MISS-03] ${samples['S-MISS-03'].window.detail}`);
  console.log('走法二 · 显示错过本班后续订的那一班');
  console.log(`  [S-MISS-03] ${samples['S-MISS-03'].rebook.detail}`);
  console.log('自动生成的实例');
  console.log(`  [S-WRONG-04] 误乘：${samples['S-WRONG-04'].wrong.detail}`);
  console.log(`  [S-XFER-05] 正确换乘：${samples['S-XFER-05'].transfer.detail}`);
  console.log(`  [S-STALE-06] 过期通知：${samples['S-STALE-06'].stale.detail}`);
  console.log('只调整第二班后的复验（S-DELAY-02）');
  console.log(`  调整集合：${reverify.changed.join(', ')} ｜ 未变：${reverify.unchanged.join(', ')}`);
  for (const e of reverify.original) {
    console.log(`  原班乘客 ${e.who}：${e.ok ? '✔' : '✘'} ${e.boards.map((b) => `${b.service}@${ts(b.t)}`).join('、')}`);
  }
  for (const e of reverify.adjusted) {
    for (const b of e.boards) {
      console.log(
        `  晚点班乘客 ${e.who}：${b.service}@${ts(b.t)} 旧表截止 ${ts(b.beforeDeadline)} ✗ → 调整后截止 ${ts(
          b.afterDeadline
        )} ✔`
      );
    }
  }
}

function cmdSamples(analysis) {
  for (const s of SAMPLES) console.log(`${s.id} ${s.title}：${s.story}`);
  console.log('');
  printReconstruction(analysis.after);
}

function cmdResolve(argv) {
  const [serviceId, rule, ...rest] = argv;
  if (!serviceId || !END_RULES.includes(rule)) {
    console.error(`用法：resolve <班次> <${END_RULES.join('|')}> [--note "说明"]`);
    process.exit(1);
  }
  if (!LEGACY.services.some((s) => s.id === serviceId)) {
    console.error(`未知班次 ${serviceId}（可选：${LEGACY.services.map((s) => s.id).join(', ')}）`);
    process.exit(1);
  }
  const noteIdx = rest.indexOf('--note');
  const note = noteIdx >= 0 ? rest.slice(noteIdx + 1).join(' ') : null;
  const resolutions = loadResolutions();
  resolutions[serviceId] = {
    endRule: rule,
    note,
    at: new Date().toISOString().slice(0, 10),
  };
  saveResolutions(resolutions);
  const after = reconstructSchedule({
    legacy: LEGACY,
    log: runAnalysis(resolutions).log,
    resolutions,
    applyAdjustments: true,
  });
  console.log(`已保存人工选择：${serviceId} → ${ruleLabel(rule)}${note ? `（${note}）` : ''}`);
  const applied = after.applied.find((a) => a.service === serviceId);
  const rejected = after.rejected.find((r) => r.service === serviceId);
  if (applied) console.log('重建已应用该选择。');
  if (rejected) console.log(`警告：该选择与轨迹证据矛盾，重建时被拒绝（${rejected.reason}）。`);
  if (after.unresolved.length) console.log(`仍待裁定：${after.unresolved.join(', ')}`);
}

function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const resolutions = loadResolutions();
  const analysis = runAnalysis(resolutions);
  switch (cmd) {
    case 'samples':
      cmdSamples(analysis);
      break;
    case 'reconstruct':
      printReconstruction(analysis.after);
      break;
    case 'check':
      printChecks(analysis);
      break;
    case 'view': {
      const id = argv[0] ?? 'LG-S1';
      const service = analysis.after.services.find((s) => s.id === id);
      if (!service) {
        console.error(`未知班次 ${id}`);
        process.exit(1);
      }
      console.log(renderPlatformView(platformView({ service, log: analysis.log })));
      break;
    }
    case 'resolve':
      cmdResolve(argv);
      break;
    case 'report': {
      mkdirSync(dirname(REPORT_PATH), { recursive: true });
      writeFileSync(REPORT_PATH, generateReport(analysis, resolutions) + '\n');
      console.log(`维护说明已生成：${REPORT_PATH}`);
      break;
    }
    case 'all':
      cmdSamples(analysis);
      console.log('');
      printChecks(analysis);
      console.log('');
      mkdirSync(dirname(REPORT_PATH), { recursive: true });
      writeFileSync(REPORT_PATH, generateReport(analysis, resolutions) + '\n');
      console.log(`维护说明已生成：${REPORT_PATH}`);
      break;
    default:
      console.log(`用法：node src/maintenance/cli.js <命令>

  samples              列出班次样例（S-EDGE-01 … S-STALE-06）与重建结果
  reconstruct          从真实调度数据重建班次样例（应用已保存的人工选择）
  check                运行维护检查器（两种实测走法 + 实例 + 复验）
  view <班次>          站台视图：逐拍查看预约、开门和真正登乘的时刻
  resolve <班次> <inclusive|exclusive> [--note "…"]   保存歧义班次的人工选择
  report               生成 docs/maintenance.md 维护说明
  all                  samples + check + report`);
  }
}

main();
