// The character "stands" on the bottom of the screen; gravity from the real phone pushes it sideways.
// Pure logic: unit-tested and independent of three.js.

export interface BodyState {
  x: number; // position along the floor, world units, 0 = centre
  vx: number; // velocity, units/s
  lean: number; // body roll, radians (positive = leaning to the left)
}

export interface StepResult {
  state: BodyState;
  bumped: boolean; // hit a screen edge hard enough to react
}

export const FLOOR_HALF_WIDTH = 1.0;
const DEAD_ZONE = 1.7; // m/s² of sideways gravity ignored (≈10°: hand wobble does nothing)
const SLIDE_GAIN = 0.25; // downhill acceleration per m/s² of sideways gravity beyond the dead zone (like on ice)
const FRICTION = 2.2; // 1/s velocity damping
const MAX_SPEED = 1.3;
const CUSHION = 0.35; // world units before the floor's end where it slows down softly
const MAX_LEAN = 0.35; // small lean into the slope: big rotations would swing the body off the narrow screen
const LEAN_EASE = 3; // 1/s, how fast the lean follows the tilt
const BUMP_SPEED = 0.9;

export const restingBody = (): BodyState => ({ x: 0, vx: 0, lean: 0 });

/**
 * Advance the body by dt seconds.
 * gravityX is the phone's sideways gravity reading (m/s²): negative when the right edge is lower.
 * walkTarget, if set, makes the character walk there on its own (idle wandering) when the phone is level.
 */
export function step(
  prev: BodyState,
  gravityX: number,
  dt: number,
  walkTarget: number | null = null,
  halfWidth = FLOOR_HALF_WIDTH,
): StepResult {
  const d = Math.min(Math.max(dt, 0), 0.05); // clamp big frame gaps so nothing jumps

  // A real slide: beyond the dead zone the character accelerates downhill (gravityX < 0 means the right edge is lower).
  const beyond = Math.max(0, Math.abs(gravityX) - DEAD_ZONE);
  let accel = -Math.sign(gravityX) * beyond * SLIDE_GAIN;
  if (beyond === 0 && walkTarget !== null) {
    const gap = walkTarget - prev.x;
    accel = Math.abs(gap) > 0.05 ? Math.sign(gap) * 1.0 : 0;
  }
  // Soft cushion near the floor's ends: moving towards an end slows it down instead of slamming.
  const toEnd = halfWidth - Math.abs(prev.x);
  if (toEnd < CUSHION && Math.sign(prev.vx) === Math.sign(prev.x)) accel -= prev.vx * (1 - toEnd / CUSHION) * 6;

  let vx = prev.vx + accel * d;
  vx -= vx * Math.min(FRICTION * d, 1);
  vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, vx));

  let x = prev.x + vx * d;
  let bumped = false;
  if (x > halfWidth || x < -halfWidth) {
    bumped = Math.abs(vx) > BUMP_SPEED;
    x = Math.max(-halfWidth, Math.min(halfWidth, x));
    vx = bumped ? -vx * 0.25 : 0; // a small bounce off the edge
  }

  // Lean slightly into the slope (counter-clockwise when the right edge drops), never far enough to leave the screen.
  const targetLean = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, Math.asin(Math.max(-1, Math.min(1, -gravityX / 9.81)))));
  const lean = prev.lean + (targetLean - prev.lean) * Math.min(LEAN_EASE * d, 1);

  return { state: { x, vx, lean }, bumped };
}
