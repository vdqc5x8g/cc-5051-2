// Station geometry and walking graph.
// Metres, seconds. Decks are only connected by the two periodic lift platforms.

export const DECKS = [
  { id: 0, name: 'L0', label: '地面层' },
  { id: 1, name: 'L1', label: '夹层' },
  { id: 2, name: 'L2', label: '站厅层' },
  { id: 3, name: 'L3', label: '高层' },
].map((d) => ({ ...d, y: d.id * 4 }));

export const DECK_BY_ID = new Map(DECKS.map((d) => [d.id, d]));

export const WALK_SPEED = 1.25; // m/s
export const CAUTION_CROSS = 0.25; // extra care while crossing the gap
export const BOARD_BUFFER = 0.4; // fully aboard this long before doors close
export const ALIGHT_BUFFER = 0.35;

// Platform car half-width and the gap to the deck cut edge.
export const PLATFORM_HALF_WIDTH = 1.1;
export const PLATFORM_GAP = 0.4;

export const SHAFTS = {
  A: {
    id: 'A',
    name: 'A 平台',
    shaftX: -6,
    halfWidth: PLATFORM_HALF_WIDTH,
    gap: PLATFORM_GAP,
    edgeX: -4.5, // corridor-side deck cut edge
    holdX: -3.5, // safe holding area, 1.0 m behind the edge line
    color: 0x5ad1ff,
  },
  B: {
    id: 'B',
    name: 'B 平台',
    shaftX: 6.6,
    halfWidth: PLATFORM_HALF_WIDTH,
    gap: PLATFORM_GAP,
    edgeX: 5.1,
    holdX: 4.1,
    color: 0xffd166,
  },
};

export const PLATFORM_IDS = ['A', 'B'];

export const SAFE_NODES = ['center', 'holdA', 'holdB'];
export const HOLD_NODE = { A: 'holdA', B: 'holdB' };
export const PLATFORM_BY_HOLD = { holdA: 'A', holdB: 'B' };
export const SAFE_X = {
  center: 0,
  holdA: SHAFTS.A.holdX,
  holdB: SHAFTS.B.holdX,
};

export const DECK_HALF_WIDTH = 11.4;
export const DECK_HALF_DEPTH = 3.0;

export function deckName(id) {
  return DECK_BY_ID.get(id)?.name ?? `L${id}`;
}

export function deckLabel(id) {
  const d = DECK_BY_ID.get(id);
  return d ? `${d.name} ${d.label}` : `L${id}`;
}

export function nodePosition(deckId, node) {
  const y = DECK_BY_ID.get(deckId).y;
  return { x: SAFE_X[node], y, z: 0 };
}

export function holdNode(platformId) {
  return HOLD_NODE[platformId];
}

export function isSafeNode(node) {
  return SAFE_NODES.includes(node);
}

export function walkDistance(nodeA, nodeB) {
  return Math.abs(SAFE_X[nodeA] - SAFE_X[nodeB]);
}

export function walkDuration(nodeA, nodeB) {
  return walkDistance(nodeA, nodeB) / WALK_SPEED;
}

/** Distance from the holding area onto the platform centre, across the gap. */
export function approachDuration(platformId) {
  return Math.abs(SHAFTS[platformId].shaftX - SHAFTS[platformId].holdX) / WALK_SPEED;
}

/** Distance from the platform centre back behind the edge line. */
export function alightDuration(platformId) {
  return Math.abs(SHAFTS[platformId].shaftX - SHAFTS[platformId].edgeX) / WALK_SPEED + CAUTION_CROSS;
}

export function edgeToPlatformX(platformId) {
  return SHAFTS[platformId].edgeX;
}

export function formatClock(t) {
  const sign = t < 0 ? '-' : '';
  const abs = Math.abs(t);
  const m = Math.floor(abs / 60);
  const s = abs - m * 60;
  return `${sign}${m}:${s.toFixed(1).padStart(4, '0')}`;
}
