// Val's little reactions to what you ask ("look at the sky" → he looks up and scans it): short additive poses on
// top of the idle clip (head turns, arm aims, a stretch, a hop), sometimes a clip, a mood or a sparkle. Pure timing
// and choice, no three.js (unit-tested in web/test/gestures-anim.test.ts); character.ts turns the numbers into bones.
import { rpsPick, type Command, type Outcome } from "./assistant";

export type GestureName =
  | "lookUp" | "lookAround" | "wrist" | "nod" | "patChest" | "lowBattery" | "charging" | "tiptoe" | "steps"
  | "pointEdge" | "tapHead" | "recall" | "recallMiss" | "wave" | "love" | "hop" | "thumbs" | "help" | "hush"
  | "ahem" | "squint" | "sniff" | "think" | "proud" | "giggle" | "coin" | "dice" | "rpsRock" | "rpsPaper" | "rpsScissors";

/** Where the right arm goes (the left mirrors it): upper and lower bone directions in the body's frame
 * (x: Val's left, y: up, z: towards you). */
export type ArmPose = "wrist" | "chest" | "head" | "chin" | "mouth" | "point" | "shade";
type Vec = readonly [number, number, number];
export const ARMS: Record<ArmPose, { upper: Vec; lower: Vec }> = {
  wrist: { upper: [-0.3, -0.5, 0.8], lower: [0.7, 0.5, 0.5] }, // forearm raised across the chest, watch up
  chest: { upper: [-0.25, -0.8, 0.5], lower: [0.6, 0.55, 0.55] }, // hand on the chest
  head: { upper: [-0.7, 0.55, 0.3], lower: [0.45, 0.8, -0.1] }, // hand on top of the head
  chin: { upper: [-0.25, -0.75, 0.6], lower: [0.3, 0.85, 0.4] }, // finger to chin
  mouth: { upper: [-0.15, -0.7, 0.7], lower: [0.4, 0.8, 0.45] }, // hand over the mouth
  point: { upper: [-0.85, 0.3, 0.45], lower: [-0.85, 0.35, 0.4] }, // arm out to the side, at the screen edge
  shade: { upper: [-0.55, 0.25, 0.8], lower: [0.55, 0.65, 0.5] }, // hand shading the eyes
};

export type GestureClip = "Yes" | "No" | "Wave" | "ThumbsUp" | "Jump" | "Walking";
export type GestureMood = "Angry" | "Surprised" | "Sad";
export interface GestureFx {
  at: number; // ms after the start
  kind: "twinkles" | "hearts" | "pop";
  char?: string; // for pop: a plain mono glyph (no colour emoji), drawn cream…
  pink?: boolean; // …or pink
}

/** One frame's additive pose; everything is 0 / null at rest. Angles in radians (pitch > 0: head down). */
export interface GesturePose {
  pitch: number;
  yaw: number; // > 0: towards Val's left (your right)
  roll: number;
  stretch: number; // body scale-y offset (+0.1 = 10 % taller)
  lift: number; // body raised, world units
  lean: number; // body tipped towards you (> 0) or back
  armR: ArmPose | null;
  armL: ArmPose | null;
  arm: number; // 0..1 arm weight
}

export interface GestureSpec {
  /** Length in ms (≤ 1500); for a held pose, the longest it may stay before it lets go on its own. */
  ms: number;
  /** Held until released (the thinking pose while the chat model answers). */
  hold?: boolean;
  /** Clips started at a time (ms). */
  clips?: readonly (readonly [number, GestureClip])[];
  /** Squash impulses at a time (ms): [at, amount]. */
  kicks?: readonly (readonly [number, number])[];
  mood?: readonly [GestureMood, number];
  fx?: readonly GestureFx[];
  pose?: (t: number, out: GesturePose) => void;
}

/** Ease in and out at the start and end of every gesture (ms), so it blends with the clip underneath. */
export const EASE_IN = 200;
export const EASE_OUT = 280;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (k: number) => {
  const c = clamp01(k);
  return c * c * (3 - 2 * c);
};

/** Smooth keyframes: [[ms, value], …] sorted by ms; held at both ends. */
export function keys(t: number, k: readonly (readonly [number, number])[]): number {
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i][0]) {
      const [t0, v0] = k[i - 1];
      const [t1, v1] = k[i];
      return v0 + (v1 - v0) * smooth((t - t0) / (t1 - t0));
    }
  }
  return k[k.length - 1][1];
}

/** A parabolic hop between two times. */
const hopAt = (t: number, from: number, to: number, height: number) => (t > from && t < to ? height * Math.sin((Math.PI * (t - from)) / (to - from)) : 0);

export const GESTURES: Record<GestureName, GestureSpec> = {
  // The sky: head up, a slow scan from his right to his left, tiny sparkles over his head.
  lookUp: {
    ms: 1400,
    fx: [{ at: 300, kind: "twinkles" }],
    pose: (t, p) => {
      p.pitch = -0.5;
      p.yaw = keys(t, [[150, -0.4], [1150, 0.4]]);
      p.stretch = 0.02;
    },
  },
  // Where are we: a look left, a look right, then a little hop.
  lookAround: {
    ms: 1450,
    kicks: [[1080, 0.12]],
    pose: (t, p) => {
      p.yaw = keys(t, [[0, 0], [300, 0.5], [550, 0.5], [850, -0.5], [1050, -0.5], [1300, 0]]);
      p.pitch = -0.08;
      p.lift = hopAt(t, 1120, 1420, 0.22);
    },
  },
  // The time: a glance at his wrist.
  wrist: {
    ms: 1400,
    pose: (t, p) => {
      p.armR = "wrist";
      p.arm = 1;
      p.pitch = keys(t, [[0, 0], [350, 0.38], [1100, 0.38], [1300, 0]]);
      p.yaw = keys(t, [[0, 0], [350, -0.25]]);
    },
  },
  nod: { ms: 1000, clips: [[0, "Yes"]] },
  // The battery: pats his chest.
  patChest: {
    ms: 1300,
    kicks: [[420, 0.05], [720, 0.05], [1020, 0.05]],
    pose: (t, p) => {
      p.armR = "chest";
      p.arm = 0.85 + 0.15 * Math.sin(t * 0.021);
      p.pitch = 0.18;
    },
  },
  // Under 20 %: a droopy pat and a little battery.
  lowBattery: {
    ms: 1500,
    mood: ["Sad", 0.8],
    fx: [{ at: 200, kind: "pop", char: "ϟ" }],
    kicks: [[500, 0.04], [850, 0.04]],
    pose: (t, p) => {
      p.armR = "chest";
      p.arm = 0.85 + 0.15 * Math.sin(t * 0.018);
      p.pitch = 0.3;
      p.stretch = -0.05;
    },
  },
  // Charging: a happy wiggle.
  charging: {
    ms: 1400,
    kicks: [[80, 0.12]],
    fx: [{ at: 120, kind: "pop", char: "ϟ", pink: true }],
    pose: (t, p) => {
      p.roll = 0.18 * Math.sin(t * 0.02);
      p.lean = 0.06 * Math.sin(t * 0.02 + 1);
      p.lift = hopAt(t, 100, 400, 0.12);
    },
  },
  // Height: up on tiptoe, squash first, stretch, settle.
  tiptoe: {
    ms: 1350,
    kicks: [[1150, 0.1]],
    pose: (t, p) => {
      p.stretch = keys(t, [[0, 0], [200, -0.07], [550, 0.13], [950, 0.13], [1200, 0]]);
      p.lift = keys(t, [[200, 0], [550, 0.1], [950, 0.1], [1200, 0]]);
      p.pitch = keys(t, [[200, 0], [550, -0.2], [950, -0.2], [1200, 0]]);
    },
  },
  // Speed: quick steps on the spot.
  steps: { ms: 1300, clips: [[0, "Walking"]], pose: (t, p) => (p.lift = 0.03 * Math.abs(Math.sin(t * 0.016))) },
  // A new timer: points at the screen edge, where the countdown runs.
  pointEdge: {
    ms: 1300,
    kicks: [[300, 0.06]],
    pose: (t, p) => {
      p.armR = "point";
      p.arm = 1;
      p.yaw = keys(t, [[0, 0], [350, -0.4]]);
      p.pitch = -0.05;
    },
  },
  // A note: taps his head, "noted".
  tapHead: {
    ms: 1250,
    fx: [{ at: 350, kind: "pop", char: "✎" }],
    pose: (t, p) => {
      p.armR = "head";
      p.arm = 1;
      p.pitch = 0.08 + 0.08 * Math.max(0, Math.sin(t * 0.022));
      p.roll = -0.1;
    },
  },
  // Recall: finger to chin, then a thumbs up (or a head shake when nothing was found).
  recall: { ms: 1500, clips: [[700, "ThumbsUp"]], pose: (t, p) => ponder(t, p, 700) },
  recallMiss: { ms: 1500, clips: [[700, "No"]], pose: (t, p) => ponder(t, p, 700) },
  wave: { ms: 1200, clips: [[0, "Wave"]] },
  // Love: hearts and a bashful head tilt.
  love: {
    ms: 1500,
    fx: [{ at: 0, kind: "hearts" }],
    pose: (t, p) => {
      p.roll = 0.3;
      p.pitch = 0.15;
      p.yaw = 0.15;
      p.lean = 0.04 * Math.sin(t * 0.008);
    },
  },
  hop: { ms: 900, clips: [[0, "Jump"]], kicks: [[0, 0.25]] },
  thumbs: { ms: 1200, clips: [[0, "ThumbsUp"]] },
  help: { ms: 1300, clips: [[0, "Wave"]], fx: [{ at: 250, kind: "twinkles" }] },
  // Mute: hands over the mouth.
  hush: {
    ms: 1400,
    mood: ["Surprised", 0.3],
    pose: (_t, p) => {
      p.armR = "mouth";
      p.armL = "mouth";
      p.arm = 1;
      p.pitch = 0.1;
    },
  },
  // Unmute: a little "ahem", fist to mouth, a bob.
  ahem: {
    ms: 1100,
    kicks: [[250, 0.1], [450, 0.08]],
    pose: (t, p) => {
      p.armR = "mouth";
      p.arm = keys(t, [[0, 1], [650, 1], [900, 0]]);
      p.pitch = keys(t, [[0, 0], [280, 0.22], [450, 0.1], [750, -0.12], [1000, 0]]);
    },
  },
  // The sun card: looks up and squints, a hand shading his eyes.
  squint: {
    ms: 1400,
    mood: ["Angry", 0.3],
    pose: (t, p) => {
      p.armR = "shade";
      p.arm = 1;
      p.pitch = -0.4;
      p.yaw = keys(t, [[200, -0.1], [1100, 0.15]]);
    },
  },
  // Metal: sniffs, head forward and down.
  sniff: {
    ms: 1300,
    kicks: [[350, 0.03], [550, 0.03], [750, 0.03]],
    pose: (t, p) => {
      p.pitch = 0.32;
      p.lean = 0.14;
      p.yaw = 0.1 * Math.sin(t * 0.012);
      p.lift = 0.015 * Math.max(0, Math.sin(t * 0.03));
    },
  },
  // Thinking about a question (held while the chat model answers): head tilt, hand on chin.
  think: { ms: 45_000, hold: true, pose: (t, p) => ponder(t, p, Infinity) },
  // A fact: a proud chin-up.
  proud: {
    ms: 1200,
    pose: (t, p) => {
      p.pitch = -0.32;
      p.stretch = 0.05;
      p.lean = -0.06;
      p.roll = keys(t, [[0, 0], [400, 0.08]]);
    },
  },
  // A joke: a hand over the mouth and a shaky little giggle.
  giggle: {
    ms: 1400,
    mood: ["Surprised", 0.25],
    kicks: [[300, 0.05], [500, 0.05], [700, 0.05]],
    fx: [{ at: 250, kind: "pop", char: "☺\uFE0E" }],
    pose: (t, p) => {
      p.armR = "mouth";
      p.arm = 1;
      p.pitch = 0.12;
      p.roll = 0.12 * Math.sin(t * 0.03);
      p.lift = 0.02 * Math.abs(Math.sin(t * 0.03));
    },
  },
  // A coin: flicked up, he follows it up with his eyes, then looks down at it.
  coin: {
    ms: 1400,
    kicks: [[120, 0.08]],
    fx: [{ at: 150, kind: "pop", char: "◎" }],
    pose: (t, p) => {
      p.armR = "point";
      p.arm = keys(t, [[0, 0], [150, 1], [400, 0]]);
      p.pitch = keys(t, [[0, 0], [300, -0.45], [800, -0.45], [1100, 0.2]]);
    },
  },
  // Dice: a hop and a die over his head.
  dice: { ms: 1100, clips: [[0, "Jump"]], kicks: [[0, 0.2]], fx: [{ at: 300, kind: "pop", char: "⚀" }] },
  // Rock paper scissors: three bobs, then his hand.
  rpsRock: rps("✊"),
  rpsPaper: rps("✋"),
  rpsScissors: rps("✌\uFE0E"),
};

/** Rock paper scissors: the fist bobs three times ("rock, paper, scissors") and the picked hand pops up. */
function rps(hand: string): GestureSpec {
  return {
    ms: 1400,
    kicks: [[250, 0.06], [550, 0.06], [850, 0.06]],
    fx: [{ at: 900, kind: "pop", char: hand }],
    pose: (t, p) => {
      p.armR = "wrist";
      p.arm = t < 1000 ? 1 : keys(t, [[1000, 1], [1150, 0]]);
      p.pitch = t < 1000 ? 0.12 * Math.abs(Math.sin((t * Math.PI) / 300)) : 0;
    },
  };
}

/** Finger to chin with a thoughtful tilt, until `until` ms. */
function ponder(t: number, p: GesturePose, until: number) {
  const w = until === Infinity ? 1 : 1 - smooth((t - (until - 150)) / 250);
  p.armR = "chin";
  p.arm = w;
  p.roll = (0.2 + 0.04 * Math.sin(t * 0.003)) * w;
  p.pitch = -0.12 * w;
  p.yaw = 0.15 * w;
}

export function restGesturePose(out: GesturePose = {} as GesturePose): GesturePose {
  out.pitch = out.yaw = out.roll = out.stretch = out.lift = out.lean = out.arm = 0;
  out.armR = out.armL = null;
  return out;
}

/**
 * The pose `t` ms into a gesture, eased in and out. `releasedFor` is how long ago a held gesture was let go
 * (null: still held). Returns false when the gesture is over (out is then the rest pose).
 */
export function gesturePose(name: GestureName, t: number, releasedFor: number | null, out: GesturePose): boolean {
  restGesturePose(out);
  const spec = GESTURES[name];
  const over = releasedFor !== null ? releasedFor >= EASE_OUT : t >= spec.ms;
  if (over || t < 0) return !over;
  spec.pose?.(t, out);
  const fadeOut = releasedFor !== null ? 1 - releasedFor / EASE_OUT : spec.hold ? 1 : (spec.ms - t) / EASE_OUT;
  const env = smooth(t / EASE_IN) * smooth(fadeOut);
  out.pitch *= env;
  out.yaw *= env;
  out.roll *= env;
  out.stretch *= env;
  out.lift *= env;
  out.lean *= env;
  out.arm = clamp01(out.arm) * env;
  return true;
}

export function copyGesturePose(from: GesturePose, to: GesturePose): GesturePose {
  to.pitch = from.pitch;
  to.yaw = from.yaw;
  to.roll = from.roll;
  to.stretch = from.stretch;
  to.lift = from.lift;
  to.lean = from.lean;
  to.armR = from.armR;
  to.armL = from.armL;
  to.arm = from.arm;
  return to;
}

/**
 * A newer reaction cut in: the older one's last pose (`from`) fades out under the new one's ease-in, so nothing
 * jumps. Adds the body and head part into `out`; returns how much of `from`'s arms still applies (0..1).
 */
export function carryOver(t: number, from: GesturePose, out: GesturePose): number {
  const k = 1 - smooth(t / EASE_IN);
  if (k <= 0) return 0;
  out.pitch += from.pitch * k;
  out.yaw += from.yaw * k;
  out.roll += from.roll * k;
  out.stretch += from.stretch * k;
  out.lift += from.lift * k;
  out.lean += from.lean * k;
  return k;
}

/** The reaction for a command and its outcome, or null for the plain emote the outcome already names. */
export function reactionFor(cmd: Pick<Command, "name" | "args">, out: Outcome): GestureName | null {
  const a = cmd.args;
  const failed = out.action.kind === "shrug";
  switch (cmd.name) {
    case "look_up":
    case "sky":
    case "dark":
      return "lookUp";
    case "place":
      return a.looking === true ? "lookUp" : "lookAround";
    case "altitude":
      return a.looking === true ? "lookUp" : failed ? null : "tiptoe";
    case "speed":
      return a.looking === true ? "lookUp" : failed ? null : "steps";
    case "clock":
      return failed ? null : a.ask === "time" || a.ask === undefined ? "wrist" : "nod";
    case "battery": {
      const level = typeof a.level === "number" ? a.level : undefined;
      if (level === undefined) return null;
      if (a.charging === true) return "charging";
      return level < 20 ? "lowBattery" : "patChest";
    }
    case "set_timer":
      return out.action.kind === "timer" ? "pointEdge" : null;
    case "remember_note":
    case "remember_photo":
      return failed ? null : "tapHead";
    case "recall_note":
      return failed ? "recallMiss" : "recall";
    case "help":
      return "help";
    case "mute":
      return "hush";
    case "unmute":
      return "ahem";
    case "sun":
      return "squint";
    case "metal":
      return "sniff";
    case "fun":
      switch (String(a.kind ?? "")) {
        case "joke":
          return "giggle";
        case "fact":
          return "proud";
        case "coin":
          return "coin";
        case "dice":
          return "dice";
        case "rps": {
          const hand = rpsPick(out.reply);
          return hand === "rock" ? "rpsRock" : hand === "paper" ? "rpsPaper" : hand === "scissors" ? "rpsScissors" : null;
        }
        default:
          return null; // the song dances, a number nods
      }
    case "smalltalk":
      switch (String(a.kind ?? "")) {
        case "greet":
        case "bye":
        case "night":
        case "name":
          return "wave";
        case "love":
          return "love";
        case "thanks":
          return "hop";
        case "how_are_you":
        case "how_about_you":
          return "thumbs";
        default:
          return null;
      }
    default:
      return null;
  }
}
