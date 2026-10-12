// Synthetic motion traces that mimic real hand movements, used by unit tests and by the
// on-phone test mode (`?replay=<name>`), so every gesture can be checked without hands.
import type { MotionSample } from "./gestures";

const G = 9.81;
const HZ = 50;

/** Upright portrait, held still (tiny hand tremor). */
function still(t: number): MotionSample {
  const n = Math.sin(t * 0.013) * 0.05;
  return { t, gravity: [n, G * 0.94, G * 0.33], linear: [n, n, n], gyro: [0, 0, 0] };
}

function build(durationMs: number, f: (t: number) => MotionSample): MotionSample[] {
  const out: MotionSample[] = [];
  for (let t = 0; t <= durationMs; t += 1000 / HZ) out.push(f(Math.round(t)));
  return out;
}

/** Tilt so the right edge drops ~35°, hold, then back to level. */
const tiltRight = () =>
  build(4000, (t) => {
    const k = t < 500 ? t / 500 : t < 3000 ? 1 : Math.max(0, 1 - (t - 3000) / 500);
    const a = k * 0.61;
    return { ...still(t), gravity: [-G * Math.sin(a), G * Math.cos(a) * 0.94, G * 0.33] };
  });

const tiltLeft = () =>
  tiltRight().map((s) => ({ ...s, gravity: [-s.gravity[0], s.gravity[1], s.gravity[2]] as [number, number, number] }));

/** Hard up-and-down jolts, ~5 Hz for 1.2 s (≈13 m/s² peaks), the wrist whipping the phone round as it goes. */
const shake = () =>
  build(2000, (t) => {
    const on = t > 300 && t < 1500;
    const ph = (t / 1000) * 2 * Math.PI * 5;
    const a = on ? 12.5 * Math.sin(ph) : 0;
    const w = on ? 5 * Math.cos(ph) : 0;
    return { ...still(t), linear: [a * 0.3, a, 0], gyro: [w, 0, w * 0.3] };
  });

/** Walking with the phone in hand: heel strikes at ~2.5 Hz jolt it hard (≈12 m/s²) but barely turn it. */
const walk = () =>
  build(4000, (t) => {
    const ph = ((t / 1000) * 2.5) % 1;
    const a = ph < 0.08 ? 12 * Math.sin((ph / 0.08) * Math.PI) : 0;
    return { ...still(t), linear: [0, a, a * 0.3], gyro: [0.6 * Math.sin(t / 200), 0, 0.4] };
  });

/** Quick twist back and forth around the long axis, ~4 Hz, no hard jolts. */
const wiggle = () =>
  build(2000, (t) => {
    const on = t > 300 && t < 1400;
    const w = on ? 6 * Math.sin((t / 1000) * 2 * Math.PI * 4) : 0;
    return { ...still(t), gyro: [0, w, 0], linear: [w * 0.2, 0, 0] };
  });

/** Turn the phone face down onto a table, then pick it back up. */
const faceDown = () =>
  build(4000, (t) => {
    const down = t > 500 && t < 2800;
    return { ...still(t), gravity: down ? [0, 0.3, -G] : still(t).gravity };
  });

/** Lie flat and still for 3.5 s, then lift it, tilting it towards the face (~40°) as it comes up. */
const pickup = () =>
  build(4500, (t) => {
    const lifting = t > 3700 && t < 4000;
    const a = t > 3700 ? Math.min(1, (t - 3700) / 200) * 0.7 : 0;
    return { t, gravity: [0, G * Math.sin(a), G * Math.cos(a)], linear: lifting ? [0, 0, 3] : [0, 0, 0], gyro: [0, 0, 0] };
  });

/** Lie flat and still for 3.5 s, then a knock on the table: one sharp jolt, the phone stays flat. */
const knock = () =>
  build(4500, (t) => {
    const hit = t >= 3700 && t < 3760;
    return { t, gravity: [0, 0, G], linear: hit ? [0.5, 0.3, 6] : [0, 0, 0], gyro: [0, 0, 0] };
  });

/** Lying flat, spun quickly on the table. */
const spin = () =>
  build(2000, (t) => {
    const on = t > 400 && t < 1200;
    return { t, gravity: [0, 0, G], linear: [0, 0, 0], gyro: [0, 0, on ? 6 : 0] };
  });

/** Turn the phone so one long edge points down (~80°), hold for holdMs, then back upright. */
const sideways = (sign: 1 | -1, holdMs = 6500) => () =>
  build(holdMs + 7000, (t) => {
    const k = t < 600 ? t / 600 : t < 600 + holdMs ? 1 : Math.max(0, 1 - (t - 600 - holdMs) / 600);
    const a = k * 1.4;
    return { ...still(t), gravity: [sign * G * Math.sin(a), G * Math.cos(a) * 0.94, G * 0.33] };
  });

/** Flip the phone upside down (camera at the bottom), hold, then back. */
const upsideDown = () =>
  build(14000, (t) => {
    const k = t < 700 ? t / 700 : t < 7200 ? 1 : Math.max(0, 1 - (t - 7200) / 700);
    const a = k * Math.PI;
    return { ...still(t), gravity: [G * Math.sin(a) * 0.15, G * Math.cos(a) * 0.94, G * 0.33] };
  });

export const TRACES: Record<string, () => MotionSample[]> = {
  still: () => build(2000, still),
  tiltRight,
  tiltLeft,
  shake,
  walk,
  wiggle,
  faceDown,
  pickup,
  knock,
  spin,
  leftSide: sideways(1),
  rightSide: sideways(-1),
  briefSide: sideways(1, 3000),
  upsideDown,
};
