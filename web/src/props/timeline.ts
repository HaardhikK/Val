// The prop reveal, as pure timing (no three.js, unit-tested): Val turns away and reaches behind his back, the prop
// pops into his hand, he brings it round to the front with a slow ease-out turn so it faces you, and then it acts
// (the scroll unrolls; the camera just settles, held towards you: no click, no flash). Character.ts turns these
// numbers into bone poses.

export type PropKind = "camera" | "scroll";

/** Milestones of the reveal, in ms from its start. */
export const REVEAL = {
  reachEnd: 300, // the hand is behind his back
  popAt: 300, // the prop appears in the hand
  turnEnd: 760, // 460 ms ease-out: the prop faces the viewer
  actionEnd: { camera: 800, scroll: 1000 } as Record<PropKind, number>, // a short settle, or the unroll (≤ 1 s in all)
  /** Safety net: the feature opens even if the reveal never finishes (the scroll's unroll ends at 1000). */
  maxMs: 1300,
  /** Turning the room back upright (when Val is on a side or upside down) runs alongside the reach. */
  rightMs: 500,
  /** The prop shrinks away when it is put back. */
  stowMs: 220,
};

export interface RevealPose {
  /** 0..1: right arm reaching behind the back. */
  reach: number;
  /** 0..1: both arms holding the prop out in front (takes over from reach). */
  hold: number;
  /** Body yaw (radians): turned away while reaching, back to face the viewer by turnEnd. */
  yaw: number;
  /** 0..1 size of the prop (a spring pop when it appears). */
  propScale: number;
  /** 0..1: the prop's turn from facing backwards (0) to facing the viewer (1). */
  propTurn: number;
  /** 0..1 progress of the prop's own action (camera settle, scroll unroll); 0 before it starts. */
  action: number;
  /** The reveal has finished; the feature may open. */
  ready: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
export const easeOut = (k: number) => 1 - Math.pow(1 - clamp01(k), 3);
/** A little overshoot, like the CSS --spring curve. */
const pop = (k: number) => {
  const c = 1.9;
  const x = clamp01(k) - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
};

const TURN_AWAY = -0.75; // radians: his right side (the reaching hand) swings back

/** The pose at `ms` since the reveal began. Writes into `out` (no allocation per frame). */
export function revealPose(kind: PropKind, ms: number, out: RevealPose): RevealPose {
  const reachK = easeInOut(clamp01(ms / REVEAL.reachEnd));
  const turnK = easeOut((ms - REVEAL.reachEnd) / (REVEAL.turnEnd - REVEAL.reachEnd));
  out.hold = ms < REVEAL.reachEnd ? 0 : turnK;
  out.reach = ms < REVEAL.reachEnd ? reachK : 1 - turnK;
  out.yaw = TURN_AWAY * (ms < REVEAL.reachEnd ? reachK : 1 - turnK);
  out.propScale = ms < REVEAL.popAt ? 0 : pop((ms - REVEAL.popAt) / 220);
  out.propTurn = ms < REVEAL.reachEnd ? 0 : turnK;
  const end = REVEAL.actionEnd[kind];
  out.action = ms < REVEAL.turnEnd ? 0 : clamp01((ms - REVEAL.turnEnd) / (end - REVEAL.turnEnd));
  out.ready = ms >= end;
  return out;
}

/** When the reveal is done (the pose reports ready), by the wall clock: Character finishes it then even without a frame. */
export function revealDueMs(kind: PropKind): number {
  return REVEAL.actionEnd[kind];
}

/** How much of the prop is left (1 → 0) `ms` after it started going away; wall-clock, so a stalled frame loop catches up. */
export function stowLeft(ms: number): number {
  return clamp01(1 - ms / REVEAL.stowMs);
}

/** A fresh pose object (allocate once, reuse with revealPose). */
export function restPose(): RevealPose {
  return { reach: 0, hold: 0, yaw: 0, propScale: 0, propTurn: 0, action: 0, ready: false };
}

/** Shortest-way angle interpolation for turning the room back upright: from `a0` to `a1` at k (0..1, eased). */
export function rightingAngle(a0: number, a1: number, k: number): number {
  let d = a1 - a0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a0 + d * easeOut(k);
}
