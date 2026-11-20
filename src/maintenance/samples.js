// 班次样例世界：旧版时刻表（缺少结束时刻约定）+ 一份真实调度数据。
// 六个维护样例（S-EDGE-01 … S-STALE-06）都从这份数据重建或核对。

export const LEGACY = {
  note: '旧版时刻表：只记录到发与开关门时刻，未约定结束时刻是否仍可登车（endRule 缺失）',
  services: [
    { id: 'LG-S1', lift: 'A', deck: 0, arrive: 100.0, depart: 105.0, gateOpen: 100.8, gateClose: 104.2, endRule: null },
    { id: 'LG-S2', lift: 'A', deck: 0, arrive: 127.0, depart: 132.0, gateOpen: 127.8, gateClose: 131.2, endRule: null },
    { id: 'LG-B1', lift: 'B', deck: 0, arrive: 102.0, depart: 108.0, gateOpen: 102.8, gateClose: 107.2, endRule: null },
    { id: 'LG-S3', lift: 'B', deck: 2, arrive: 200.0, depart: 206.0, gateOpen: 200.8, gateClose: 205.2, endRule: null },
  ],
};

/**
 * 真实调度数据：传感器观测（arrive/gate/depart）、角色轨迹（track/board/alight）、
 * 预订（booking）与通知（notify）。LG-S2 在传感器观测中临时晚点 +6.0s。
 */
export function buildDispatchLog() {
  const records = [
    // —— 传感器观测：LG-S1 / LG-B1 / LG-S3 准点；LG-S2 临时晚点 +6.0s ——
    { t: 100.0, type: 'arrive', lift: 'A', deck: 0 },
    { t: 100.8, type: 'gate', lift: 'A', deck: 0, state: 'open' },
    { t: 104.2, type: 'gate', lift: 'A', deck: 0, state: 'closed' },
    { t: 105.0, type: 'depart', lift: 'A', deck: 0 },
    { t: 102.0, type: 'arrive', lift: 'B', deck: 0 },
    { t: 102.8, type: 'gate', lift: 'B', deck: 0, state: 'open' },
    { t: 107.2, type: 'gate', lift: 'B', deck: 0, state: 'closed' },
    { t: 108.0, type: 'depart', lift: 'B', deck: 0 },
    { t: 133.0, type: 'arrive', lift: 'A', deck: 0 },
    { t: 133.8, type: 'gate', lift: 'A', deck: 0, state: 'open' },
    { t: 137.2, type: 'gate', lift: 'A', deck: 0, state: 'closed' },
    { t: 138.0, type: 'depart', lift: 'A', deck: 0 },
    { t: 200.0, type: 'arrive', lift: 'B', deck: 2 },
    { t: 200.8, type: 'gate', lift: 'B', deck: 2, state: 'open' },
    { t: 205.2, type: 'gate', lift: 'B', deck: 2, state: 'closed' },
    { t: 206.0, type: 'depart', lift: 'B', deck: 2 },

    // —— P6（S-XFER-05 正确换乘）：B 接驳 → A LG-S1 ——
    { t: 95.0, type: 'booking', who: 'P6', lift: 'A', deck: 0, service: 'LG-S1' },
    { t: 96.5, type: 'alight', who: 'P6', lift: 'B', deck: 0, service: 'EXT-B0' },
    { t: 102.6, type: 'track', who: 'P6', deck: 0, node: 'holdA' },
    { t: 103.0, type: 'board', who: 'P6', lift: 'A', deck: 0, service: 'LG-S1' },
    { t: 117.0, type: 'alight', who: 'P6', lift: 'A', deck: 3, service: 'LG-S1' },

    // —— P1（S-EDGE-01 边界）：完成登乘的时刻恰为闸门关闭时刻 ——
    { t: 96.1, type: 'alight', who: 'P1', lift: 'B', deck: 0, service: 'EXT-B0' },
    { t: 98.0, type: 'booking', who: 'P1', lift: 'A', deck: 0, service: 'LG-S1' },
    { t: 102.2, type: 'track', who: 'P1', deck: 0, node: 'holdA' },
    { t: 104.2, type: 'board', who: 'P1', lift: 'A', deck: 0, service: 'LG-S1' },
    { t: 117.0, type: 'alight', who: 'P1', lift: 'A', deck: 3, service: 'LG-S1' },

    // —— P4（S-MISS-03 漏乘 + 续订晚点班）——
    { t: 98.5, type: 'booking', who: 'P4', lift: 'A', deck: 0, service: 'LG-S1' },
    { t: 101.7, type: 'track', who: 'P4', deck: 0, node: 'center' },
    { t: 104.5, type: 'track', who: 'P4', deck: 0, node: 'holdA' },
    { t: 104.6, type: 'booking', who: 'P4', lift: 'A', deck: 0, service: 'LG-S2' },
    { t: 120.0, type: 'track', who: 'P4', deck: 0, node: 'holdA' },
    { t: 136.0, type: 'board', who: 'P4', lift: 'A', deck: 0, service: 'LG-S2' },
    { t: 149.8, type: 'alight', who: 'P4', lift: 'A', deck: 3, service: 'LG-S2' },

    // —— P5（S-WRONG-04 误乘）：预订 LG-S2 却登上 LG-S1 ——
    { t: 99.0, type: 'booking', who: 'P5', lift: 'A', deck: 0, service: 'LG-S2' },
    { t: 102.0, type: 'track', who: 'P5', deck: 0, node: 'holdA' },
    { t: 104.0, type: 'board', who: 'P5', lift: 'A', deck: 0, service: 'LG-S1' },
    { t: 117.0, type: 'alight', who: 'P5', lift: 'A', deck: 3, service: 'LG-S1' },

    // —— P7（S-STALE-06 过期通知）：已登上 B 车厢仍收到 A 旧站台的上车通知 ——
    { t: 97.0, type: 'booking', who: 'P7', lift: 'A', deck: 0, service: 'LG-S1' },
    { t: 99.5, type: 'booking', who: 'P7', lift: 'B', deck: 0, service: 'LG-B1' },
    { t: 100.5, type: 'track', who: 'P7', deck: 0, node: 'holdB' },
    { t: 103.5, type: 'board', who: 'P7', lift: 'B', deck: 0, service: 'LG-B1' },
    { t: 104.0, type: 'notify', who: 'P7', lift: 'A', deck: 0, service: 'LG-S1', text: '请前往 A 站台搭乘 LG-S1' },
    { t: 118.3, type: 'alight', who: 'P7', lift: 'B', deck: 2, service: 'LG-B1' },

    // —— P8：LG-S2 普通乘客（非边界证据）——
    { t: 105.5, type: 'booking', who: 'P8', lift: 'A', deck: 0, service: 'LG-S2' },
    { t: 130.0, type: 'track', who: 'P8', deck: 0, node: 'holdA' },
    { t: 135.0, type: 'board', who: 'P8', lift: 'A', deck: 0, service: 'LG-S2' },
    { t: 149.8, type: 'alight', who: 'P8', lift: 'A', deck: 3, service: 'LG-S2' },
  ];
  records.sort((a, b) => a.t - b.t);
  return {
    meta: { id: 'dispatch-2026-11-20', note: '真实调度数据：传感器观测 + 角色轨迹 + 预订/通知' },
    records,
  };
}

export const SAMPLES = [
  {
    id: 'S-EDGE-01',
    title: '闸门正好关上时的登乘边界',
    service: 'LG-S1',
    who: 'P1',
    story:
      'P1 由接驳梯换乘至 A 站台，完成登乘的时刻恰为 LG-S1 关门时刻 104.2；' +
      '旧版时刻表未约定结束时刻是否仍可登车，需用轨迹判定。',
  },
  {
    id: 'S-DELAY-02',
    title: '下一班同名平台临时晚点',
    service: 'LG-S2',
    story:
      'LG-S1 的下一班同名平台 LG-S2（A@L0）传感器观测晚点 +6.0s；' +
      '只调整第二班后重新验证，原班乘客的预订与轨迹仍需核对无误。',
  },
  {
    id: 'S-MISS-03',
    title: '漏乘与续订',
    service: 'LG-S1',
    who: 'P4',
    story:
      'P4 于 104.5 到达候车区，窗口已于 104.2 关闭 → 漏乘 LG-S1；' +
      '104.6 续订临时晚点的 LG-S2，136.0 完成登乘。',
  },
  {
    id: 'S-WRONG-04',
    title: '误乘',
    who: 'P5',
    story: 'P5 预订 LG-S2（旧表 132.0 发车），却在 104.0 登上 LG-S1（105.0 发车）。',
  },
  {
    id: 'S-XFER-05',
    title: '正确换乘',
    who: 'P6',
    story:
      'P6 由 B 平台换乘 A 平台：96.5 离车 → 103.0 登乘 LG-S1，' +
      '换乘用时覆盖步行下限且登乘在窗口内。',
  },
  {
    id: 'S-STALE-06',
    title: '旧站台的过期上车通知',
    who: 'P7',
    story:
      'P7 已于 103.5 登上 B 平台车厢，104.0 仍收到 A 旧站台 LG-S1 的上车通知' +
      '（99.5 已改订 LG-B1）——同一角色已站在新平台上，旧站台通知已过期。',
  },
];
