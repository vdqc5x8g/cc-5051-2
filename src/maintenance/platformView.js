// 站台视图：逐拍查看预约、开门和角色真正登乘的时刻。
// 常规拍（step 秒）之外，每个关键事件的精确时刻也占一拍。

import { GATE_RAMP } from '../core/timetable.js';
import { characters, positionAt, recordsOf, ts } from './dispatch.js';

const EPS = 1e-9;

function doorLabel(service, t) {
  if (t < service.gateOpen - EPS) return '关闭';
  if (t < service.gateOpen + GATE_RAMP - EPS) return '开启中';
  if (t <= service.gateClose - GATE_RAMP + EPS) return '开启';
  if (t <= service.gateClose + EPS) return '关闭中';
  return '关闭';
}

function eventLabel(r) {
  switch (r.type) {
    case 'arrive':
      return '到站';
    case 'depart':
      return '发车';
    case 'gate':
      return r.state === 'open' ? '开门' : '关门（窗口结束）';
    case 'board':
      return `${r.who} 登乘`;
    case 'alight':
      return `${r.who} 离车`;
    case 'booking':
      return `${r.who} 预约`;
    case 'notify':
      return `通知 ${r.who}：${r.text ?? ''}`;
    case 'track':
      return `${r.who} 到达候车区`;
    default:
      return r.type;
  }
}

export function platformView({ service, log, step = 0.5, from, to }) {
  const { lift, deck } = service;
  const bookings = recordsOf(log, 'booking').filter((r) => r.service === service.id);
  const boards = recordsOf(log, 'board').filter((r) => r.service === service.id);
  const start = from ?? Math.min(service.arrive - 2, ...bookings.map((b) => b.t));
  const end = to ?? service.depart + 0.5;

  const relevant = log.records.filter(
    (r) =>
      (r.lift === lift && r.deck === deck && ['arrive', 'depart', 'gate', 'board', 'alight', 'notify'].includes(r.type)) ||
      (r.type === 'booking' && r.service === service.id) ||
      (r.type === 'notify' && r.service === service.id) ||
      (r.type === 'track' && r.deck === deck && r.node === `hold${lift}`)
  );

  const times = new Set();
  for (let t = start; t <= end + EPS; t += step) times.add(Math.round(t * 1000) / 1000);
  for (const r of relevant) times.add(Math.round(r.t * 1000) / 1000);

  const who_all = characters(log);
  const ticks = [...times]
    .sort((a, b) => a - b)
    .filter((t) => t >= start - EPS && t <= end + EPS)
    .map((t) => {
      const hold = [];
      const bay = [];
      for (const who of who_all) {
        const p = positionAt(log, who, t);
        if (!p || p.deck !== deck) continue;
        if (p.node === `hold${lift}`) hold.push(who);
        if (p.node === `bay${lift}`) bay.push(who);
      }
      const events = relevant.filter((r) => Math.abs(r.t - t) < EPS).map(eventLabel);
      return { t, door: doorLabel(service, t), hold, bay, events };
    });

  return {
    service: service.id,
    lift,
    deck,
    moments: {
      reserved: bookings.map((b) => ({ who: b.who, t: b.t })),
      gateOpen: service.gateOpen,
      boarded: boards.map((b) => ({ who: b.who, t: b.t })),
      gateClose: service.gateClose,
      depart: service.depart,
    },
    ticks,
  };
}

export function renderPlatformView(view) {
  const m = view.moments;
  const fmtWho = (list) => (list.length ? list.map((x) => `${x.who} ${ts(x.t)}`).join('、') : '—');
  const lines = [];
  lines.push(
    `站台视图 · ${view.service}（${view.lift} 平台 @ L${view.deck}）开门 ${ts(m.gateOpen)} · 关门 ${ts(
      m.gateClose
    )} · 发车 ${ts(m.depart)}`
  );
  lines.push(`预约：${fmtWho(m.reserved)} ｜ 真正登乘：${fmtWho(m.boarded)}`);
  lines.push('');
  lines.push('| 拍 | 门 | 候车 | 车内 | 事件 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const tk of view.ticks) {
    lines.push(
      `| ${ts(tk.t)} | ${tk.door} | ${tk.hold.join(' ') || '—'} | ${tk.bay.join(' ') || '—'} | ${
        tk.events.join('；') || ''
      } |`
    );
  }
  return lines.join('\n');
}
