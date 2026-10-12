// "Knock on the table": the app (Knock.kt) finds the knocks in the fast accelerometer and sends
//   { type: "knock", n, side, peak }  as each knock lands (n = knocks so far in this group), and
//   { type: "knocks", n, side }       once the pause after the last knock closes the group.
// This file is the page's pure part: parsing, what Val does for a group, and the seismograph trace.
import type { Mode } from "./character";

export type KnockSide = "left" | "right" | "top" | "bottom";
export type KnockEvent =
  | { type: "knock"; n: number; side: KnockSide | null; peak: number }
  | { type: "knocks"; n: number; side: KnockSide | null };

const SIDES = new Set(["left", "right", "top", "bottom"]);

/** Validates a knock message from the app; anything malformed is dropped. */
export function parseKnock(msg: Record<string, unknown>): KnockEvent | null {
  if (msg.type !== "knock" && msg.type !== "knocks") return null;
  const n = Number(msg.n);
  if (!Number.isInteger(n) || n < 1 || n > 9) return null;
  const side = typeof msg.side === "string" && SIDES.has(msg.side) ? (msg.side as KnockSide) : null;
  if (msg.type === "knocks") return { type: "knocks", n, side };
  return { type: "knock", n, side, peak: Math.min(Math.max(Number(msg.peak) || 0, 0), 50) };
}

export type KnockReaction = "hop" | "wake" | "whosThere" | "dance" | "none";

/** What Val does once a group of knocks is complete. Busy modes (falling, carried, tumbling, dancing) ignore knocks. */
export function knockReaction(n: number, mode: Mode): KnockReaction {
  if (mode === "sleeping") return n >= 2 ? "wake" : "none"; // one knock is not enough to wake him
  if (mode !== "normal") return "none";
  if (n === 1) return "hop";
  if (n === 2) return "whosThere";
  return "dance";
}

/** Where Val glances for a knock from `side`, as a screen direction (x right, y up); null looks straight out. */
export function glanceDir(side: KnockSide | null): [number, number] | null {
  switch (side) {
    case "left":
      return [-1, 0];
    case "right":
      return [1, 0];
    case "top":
      return [0, 1];
    case "bottom":
      return [0, -1];
    default:
      return null;
  }
}

// ---- Seismograph: a thin scrolling line; each knock rings as a damped wiggle drawn in amber ----
export const SEISMO_POINTS = 96; // samples across the strip
export const SEISMO_HZ = 48; // samples per second (the strip holds 2 s)
export const SEISMO_HOLD_MS = 2000; // visible this long after the last knock …
export const SEISMO_FADE_MS = 400; // … then fades out over this
const RING_DECAY = 7; // 1/s: how fast a knock's wiggle dies out
const RING_FREQ = 9; // Hz of the wiggle
const SPIKE_LEVEL = 0.12; // above this ring energy a sample is drawn as part of the spike (amber)

/** The trace behind the seismograph: fixed-size ring buffers, no allocations after construction. */
export class SeismoTrace {
  readonly value = new Float32Array(SEISMO_POINTS); // -1..1
  readonly spike = new Uint8Array(SEISMO_POINTS); // 1 = drawn amber
  head = 0; // index of the oldest sample
  private energy = 0;
  private phase = 0;
  private lastStep = -1;
  private lastKnockAt = -Infinity;
  private seed = 1;

  /** A knock landed: `strength` 0..1 sets the spike height. */
  kick(now: number, strength: number) {
    this.energy = Math.min(1, Math.max(this.energy, 0.35 + 0.65 * strength));
    this.phase = 0;
    this.lastKnockAt = now;
    if (this.lastStep < 0) { // first knock after a quiet spell: a fresh, flat strip that starts scrolling now
      this.value.fill(0);
      this.spike.fill(0);
      this.lastStep = now;
    }
  }

  /** 0..1 strip opacity at `now`. */
  opacity(now: number) {
    const since = now - this.lastKnockAt;
    if (since <= SEISMO_HOLD_MS) return 1;
    return Math.max(0, 1 - (since - SEISMO_HOLD_MS) / SEISMO_FADE_MS);
  }

  /** Scroll forward to `now`; returns false when there is nothing to draw (hidden). */
  advance(now: number): boolean {
    if (this.opacity(now) <= 0) {
      this.lastStep = -1;
      return false;
    }
    const stepMs = 1000 / SEISMO_HZ;
    let steps = Math.floor((now - this.lastStep) / stepMs);
    if (steps > SEISMO_POINTS) { // after a stall, just refill the strip (the skipped time still damps the ring)
      this.energy *= Math.exp((-RING_DECAY * (steps - SEISMO_POINTS) * stepMs) / 1000);
      steps = SEISMO_POINTS;
    }
    for (let i = 0; i < steps; i++) this.sample(stepMs / 1000);
    this.lastStep += steps * stepMs;
    if (now - this.lastStep > stepMs * 2) this.lastStep = now; // never fall far behind
    return true;
  }

  private sample(dt: number) {
    this.seed = (this.seed * 16807) % 2147483647; // cheap deterministic noise for the idle line
    const noise = ((this.seed / 2147483647) * 2 - 1) * 0.05;
    this.phase += dt;
    const ring = this.energy * Math.sin(2 * Math.PI * RING_FREQ * this.phase);
    this.value[this.head] = noise + ring;
    this.spike[this.head] = this.energy > SPIKE_LEVEL ? 1 : 0;
    this.head = (this.head + 1) % SEISMO_POINTS;
    this.energy *= Math.exp(-RING_DECAY * dt);
  }
}
