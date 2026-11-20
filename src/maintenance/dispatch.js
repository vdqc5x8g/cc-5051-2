// 真实调度数据（dispatch log）的记录模型与查询。
// 维护工具只消费这份日志与旧版时刻表：传感器观测（到站/开门/关门/发车）、
// 角色轨迹（track/board/alight）、预订（booking）与通知（notify）。

export const ts = (t) => t.toFixed(1);

export function recordsOf(log, type) {
  return log.records.filter((r) => r.type === type);
}

export function characters(log) {
  return [...new Set(log.records.filter((r) => r.who).map((r) => r.who))].sort();
}

export function bookingsOf(log, who) {
  return recordsOf(log, 'booking')
    .filter((r) => r.who === who)
    .sort((a, b) => a.t - b.t);
}

export function boardEvents(log, who) {
  return recordsOf(log, 'board')
    .filter((r) => r.who === who)
    .sort((a, b) => a.t - b.t);
}

/** 角色在时刻 t 的最近已知位置：{deck, node, aboard}；节点含 center / holdX / bayX。 */
export function positionAt(log, who, t) {
  let pos = null;
  for (const r of log.records) {
    if (r.who !== who || r.t > t + 1e-9) continue;
    if (r.type === 'track') pos = { deck: r.deck, node: r.node, aboard: null };
    else if (r.type === 'board') pos = { deck: r.deck, node: `bay${r.lift}`, aboard: r.lift };
    else if (r.type === 'alight') pos = { deck: r.deck, node: `hold${r.lift}`, aboard: null };
  }
  return pos;
}

/** 角色在 until 之前首次被观测到位于 deck 的 node（track/board/alight）。 */
export function firstArrivalAt(log, who, deck, node, until = Infinity) {
  let best = null;
  for (const r of log.records) {
    if (r.who !== who || r.t > until + 1e-9) continue;
    const hit =
      (r.type === 'track' && r.deck === deck && r.node === node) ||
      (r.type === 'board' && r.deck === deck && node === `bay${r.lift}`) ||
      (r.type === 'alight' && r.deck === deck && node === `hold${r.lift}`);
    if (hit && (best === null || r.t < best)) best = r.t;
  }
  return best;
}
