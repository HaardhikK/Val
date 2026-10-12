// Turns raw phone motion samples into gestures (shake, wiggle, face-down, pick-up, spin).
// Pure logic, no three.js, so it is unit-tested and replayable.
//
// Axes follow Android's sensor frame: x to the right edge, y to the top edge, z out of the screen.
// Gravity is the "up" reaction vector (m/s²): upright portrait ≈ (0, 9.8, 0), flat face-up ≈ (0, 0, 9.8).

export interface MotionSample {
  t: number; // ms
  gravity: [number, number, number]; // m/s²
  linear: [number, number, number]; // linear acceleration without gravity, m/s²
  gyro: [number, number, number]; // rad/s
}

export type Gesture = "shake" | "wiggle" | "faceDown" | "faceUp" | "pickup" | "spin";

const SHAKE_ACCEL = 10.5; // m/s² peak of the fused 50 Hz linear acceleration (normal handling peaks near 6.5)
const SHAKE_TURN = 3; // rad/s: a real shake also whips the phone round; walking jolts it without turning it
const SHAKE_PEAKS = 3;
const SHAKE_WINDOW = 900; // ms
const WIGGLE_RATE = 3.0; // rad/s twist around the long axis
const WIGGLE_FLIPS = 4;
const WIGGLE_WINDOW = 1000; // ms
const FACE_DOWN_Z = -7.5; // m/s²
const FACE_HOLD = 600; // ms
const REST_ACCEL = 0.35; // m/s²
const REST_HOLD = 3000; // ms
const PICKUP_ACCEL = 1.8; // m/s²
const PICKUP_TILT_Z = 8; // m/s²: a lift tilts the phone off flat; a knock on the table does not
const PICKUP_TILT_MS = 300; // ms after the jolt for the tilt to show
const SPIN_RATE = 4.0; // rad/s around z while roughly flat
const SPIN_HOLD = 300; // ms
const COOLDOWN = 1500; // ms between two gestures of the same kind

const mag = (v: [number, number, number]) => Math.hypot(v[0], v[1], v[2]);

export class GestureDetector {
  private shakePeaks: number[] = [];
  private lastPeakAbove = false;
  private lastTurnAt = -Infinity;
  private wiggleFlips: number[] = [];
  private lastWiggleSign = 0;
  private faceDownSince: number | null = null;
  private isFaceDown = false;
  private restSince: number | null = null;
  private wasResting = false;
  private lastFlatAt = 0;
  private pickupJoltAt: number | null = null;
  private spinSince: number | null = null;
  private lastFired: Partial<Record<Gesture, number>> = {};

  /** Feed one sample; returns the gestures it completes (usually none). */
  push(s: MotionSample): Gesture[] {
    const out: Gesture[] = [];
    const fire = (g: Gesture) => {
      const last = this.lastFired[g];
      if (last !== undefined && s.t - last < COOLDOWN) return;
      this.lastFired[g] = s.t;
      out.push(g);
    };

    const accel = mag(s.linear);

    // Shake: several hard jolts in a short window, with the phone also turned fast (so walking does not count).
    if (mag(s.gyro) > SHAKE_TURN) this.lastTurnAt = s.t;
    const above = accel > SHAKE_ACCEL;
    if (above && !this.lastPeakAbove) this.shakePeaks.push(s.t);
    this.lastPeakAbove = above;
    this.shakePeaks = this.shakePeaks.filter((t) => s.t - t <= SHAKE_WINDOW);
    if (this.shakePeaks.length >= SHAKE_PEAKS && s.t - this.lastTurnAt <= SHAKE_WINDOW) {
      this.shakePeaks = [];
      fire("shake");
    }

    // Wiggle: fast back-and-forth twist around the phone's long (y) axis, without hard jolts.
    const twist = s.gyro[1];
    const sign = Math.abs(twist) > WIGGLE_RATE ? Math.sign(twist) : 0;
    if (sign !== 0 && sign !== this.lastWiggleSign) {
      if (this.lastWiggleSign !== 0) this.wiggleFlips.push(s.t);
      this.lastWiggleSign = sign;
    }
    this.wiggleFlips = this.wiggleFlips.filter((t) => s.t - t <= WIGGLE_WINDOW);
    if (this.wiggleFlips.length >= WIGGLE_FLIPS && this.shakePeaks.length === 0) {
      this.wiggleFlips = [];
      this.lastWiggleSign = 0;
      fire("wiggle");
    }

    // Face down / face up.
    if (s.gravity[2] < FACE_DOWN_Z) {
      this.faceDownSince ??= s.t;
      if (!this.isFaceDown && s.t - this.faceDownSince >= FACE_HOLD) {
        this.isFaceDown = true;
        out.push("faceDown");
      }
    } else {
      this.faceDownSince = null;
      if (this.isFaceDown && s.gravity[2] > 0) {
        this.isFaceDown = false;
        out.push("faceUp");
      }
    }

    // Pick-up: a still phone suddenly moves, and tilts off flat within PICKUP_TILT_MS (a knock on the table only jolts).
    // Only a phone lying (roughly) flat counts as resting: a hand-held phone is never this still for long.
    // A resting phone that was lifted gently (no pickup jolt) forgets it rested after 1 s off the table.
    if (Math.abs(s.gravity[2]) > 7) this.lastFlatAt = s.t;
    else if (s.t - this.lastFlatAt > 1000) this.wasResting = false;
    if (accel < REST_ACCEL && Math.abs(s.gravity[2]) > 7) {
      this.restSince ??= s.t;
      if (s.t - this.restSince >= REST_HOLD) this.wasResting = true;
    } else {
      this.restSince = null;
      if (this.wasResting && accel > PICKUP_ACCEL && !this.isFaceDown) this.pickupJoltAt ??= s.t;
    }
    if (this.pickupJoltAt !== null) {
      if (s.t - this.pickupJoltAt > PICKUP_TILT_MS) this.pickupJoltAt = null; // only a knock: still resting
      else if (Math.abs(s.gravity[2]) < PICKUP_TILT_Z && !this.isFaceDown) {
        this.pickupJoltAt = null;
        this.wasResting = false;
        fire("pickup");
      }
    }

    // Spin: lying roughly flat and turned quickly around z.
    const flat = Math.abs(s.gravity[2]) > 7;
    if (flat && Math.abs(s.gyro[2]) > SPIN_RATE) {
      this.spinSince ??= s.t;
      if (s.t - this.spinSince >= SPIN_HOLD) {
        this.spinSince = null;
        fire("spin");
      }
    } else {
      this.spinSince = null;
    }

    return out;
  }
}
