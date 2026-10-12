// Every edge of the screen can be the floor. A slight tilt slides the character along its current floor;
// a big tilt (held briefly) makes the lowest edge the new floor, and the character falls onto it.
// Pure logic: unit-tested, no three.js.

export type Floor = "bottom" | "right" | "top" | "left";

/** Rotation (radians, counter-clockwise) that turns the bottom floor into this floor. */
export const FLOOR_ANGLE: Record<Floor, number> = { bottom: 0, right: Math.PI / 2, top: Math.PI, left: -Math.PI / 2 };

/** Screen-space "down" direction of each floor (x right, y up). */
const DOWN: Record<Floor, [number, number]> = { bottom: [0, -1], right: [1, 0], top: [0, 1], left: [-1, 0] };

const SWITCH_COS = Math.cos((70 * Math.PI) / 180); // leave the current floor once it is >70° from "down"
const MIN_IN_PLANE = 4.5; // m/s²; below this the phone is too flat for any edge to be "down"
const HOLD_SIDE_MS = 5000; // side floors need a deliberate, sustained turn
const HOLD_FLIP_MS = 250; // ...but upside down it falls right away
const HOLD_CORNER_MS = 1200; // and when it has already slid into the corner next to that floor, it goes round quickly
const FLIP_COS = Math.cos((120 * Math.PI) / 180); // the opposite floor counts as a flip

/**
 * Real-world "down" in screen space, from the phone's gravity reading (the "up" reaction vector, m/s²),
 * plus how strong the in-plane part is.
 */
export function screenDown(gravity: [number, number, number]): { dir: [number, number]; strength: number } {
  const dx = -gravity[0];
  const dy = -gravity[1];
  const strength = Math.hypot(dx, dy);
  return strength < 1e-6 ? { dir: [0, -1], strength: 0 } : { dir: [dx / strength, dy / strength], strength };
}

/** Gravity along the current floor, in the sign convention physics.step expects (negative pushes to +x). */
export function alongFloor(floor: Floor, gravity: [number, number, number]): number {
  const [dx, dy] = DOWN[floor];
  const tangent: [number, number] = [-dy, dx]; // the floor's +x direction on screen
  return gravity[0] * tangent[0] + gravity[1] * tangent[1];
}

/**
 * How far (radians, counter-clockwise on screen) the character must turn about its feet to stand upright
 * in the real world while on this floor. 0 when the phone is too flat to tell.
 */
export function uprightAngle(floor: Floor, gravity: [number, number, number]): number {
  const { dir, strength } = screenDown(gravity);
  if (strength < 3) return 0;
  const [fx, fy] = DOWN[floor];
  let a = Math.atan2(dir[1], dir[0]) - Math.atan2(fy, fx);
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** The floor that meets this floor at its +x end (sign 1) or -x end (sign -1). */
export function cornerFloor(floor: Floor, sign: 1 | -1): Floor {
  const [dx, dy] = DOWN[floor];
  const tx = -dy * sign;
  const ty = dx * sign; // the floor's +x direction on screen, times sign
  return (Object.keys(DOWN) as Floor[]).find((f) => DOWN[f][0] === tx && DOWN[f][1] === ty)!;
}

export class FloorPicker {
  floor: Floor = "bottom";
  private candidate: Floor | null = null;
  private since = 0;
  private holdMs = HOLD_SIDE_MS;
  private isLocked = false;

  /** Forget a half-finished hold (call when the picker is not being fed, e.g. while carried or asleep). */
  reset() {
    this.candidate = null;
  }

  /**
   * Feature overlays always open in portrait: the floor goes back to the bottom and tilt is ignored until unlock().
   * Returns the floor Val was on (to turn the room back from it).
   */
  lock(): Floor {
    const was = this.floor;
    this.isLocked = true;
    this.floor = "bottom";
    this.candidate = null;
    return was;
  }

  /** Tilt counts again (the overlay closed). The floor stays at the bottom until the phone is turned again. */
  unlock() {
    this.isLocked = false;
    this.candidate = null;
  }

  get locked() {
    return this.isLocked;
  }

  /** How far through the hold towards another floor we are: 0 = not holding, 1 = about to switch. */
  progress(nowMs: number): number {
    return this.candidate === null || this.holdMs < 1000 ? 0 : Math.min(1, (nowMs - this.since) / this.holdMs);
  }

  /**
   * Feed the latest gravity reading; returns the new floor when it changes, else null.
   * atCorner: the floor the character is already pressed against at the end of its floor, if any.
   */
  update(gravity: [number, number, number], nowMs: number, atCorner: Floor | null = null): Floor | null {
    if (this.locked) return null;
    const { dir, strength } = screenDown(gravity);
    if (strength < MIN_IN_PLANE) {
      this.candidate = null;
      return null;
    }
    const dot = (f: Floor) => DOWN[f][0] * dir[0] + DOWN[f][1] * dir[1];
    if (dot(this.floor) >= SWITCH_COS) {
      this.candidate = null;
      return null;
    }
    const best = (Object.keys(DOWN) as Floor[]).reduce((a, b) => (dot(b) > dot(a) ? b : a));
    if (best !== this.candidate) {
      this.candidate = best;
      this.since = nowMs;
      // Flipped (the new floor is roughly opposite the current one): fall almost at once; a side floor needs the long hold.
      this.holdMs = DOWN[best][0] * DOWN[this.floor][0] + DOWN[best][1] * DOWN[this.floor][1] < FLIP_COS ? HOLD_FLIP_MS : HOLD_SIDE_MS;
      return null;
    }
    if (atCorner === best && this.holdMs === HOLD_SIDE_MS) this.holdMs = HOLD_CORNER_MS; // already in that corner
    if (nowMs - this.since < this.holdMs) return null;
    this.floor = best;
    this.candidate = null;
    return best;
  }
}
