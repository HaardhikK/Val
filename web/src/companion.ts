// The companion bubble: while a feature overlay (camera, map) covers the screen, the robot shrinks into a small
// square in the top-left corner and keeps you company there. The canvas itself shrinks to the bubble (96 px), and the
// camera frames just the robot, so the GPU draws ~2 % of the pixels, at 30 fps instead of 60.
import * as THREE from "three";
import { DEVICE } from "./device";

/** Side of the bubble in CSS pixels. */
export const BUBBLE_PX = 96;
/** Minimum time between drawn frames in the bubble (30 fps; a few ms of slack for 60 Hz frame jitter). */
export const BUBBLE_FRAME_MS = 1000 / DEVICE.idleFps - 4;
/** Minimum time between drawn frames while asleep (~20 fps). */
export const SLEEP_FRAME_MS = DEVICE.sleepFrameMs;

/** Minimum time between drawn frames while Val stands still, or while the voice HUD listens or thinks (30 fps). */
export const IDLE_FRAME_MS = BUBBLE_FRAME_MS;
/** No touch for this long before the idle cap may start. */
export const IDLE_TOUCH_MS = 2000;
/** A gravity change bigger than this (m/s², any axis, since the last drawn frame) ends the idle cap at once. */
export const IDLE_GRAVITY_DELTA = 0.3;

export interface IdleState {
  /** Character mode is "normal" and no feature is revealing, open or closing. */
  calm: boolean;
  /** A fall across the screen or the room turning upright is under way. */
  turning: boolean;
  vx: number;
  /** Tilt along the floor (m/s²). */
  along: number;
  particles: number;
  touchAgoMs: number;
  gravityDelta: number;
  /** The voice HUD is listening or thinking: the models need the fast cores more than Val needs 60 fps. */
  voiceBusy: boolean;
}

/** True when the full-screen loop may drop to 30 fps: nothing on screen moves fast, or the voice models are busy. */
export function idleCap(s: IdleState): boolean {
  if (s.turning || s.gravityDelta > IDLE_GRAVITY_DELTA) return false;
  if (s.voiceBusy) return true; // the voice models are busy: 30 fps whatever the touch state
  return s.calm && Math.abs(s.vx) < 0.05 && Math.abs(s.along) < 0.5 && s.particles === 0 && s.touchAgoMs >= IDLE_TOUCH_MS;
}

/** How long to wait since the last drawn frame before drawing the next one. */
export function frameGap(inBubble: boolean, asleep: boolean, idle = false): number {
  return Math.max(inBubble ? BUBBLE_FRAME_MS : 0, asleep ? SLEEP_FRAME_MS : 0, idle ? IDLE_FRAME_MS : 0);
}

export interface Companion {
  /** Shrink into the corner bubble (idempotent). */
  enter(): void;
  /** Back to full screen (idempotent). */
  exit(): void;
  /** Re-aim the bubble camera at the robot; call once per drawn frame while active. */
  aim(): void;
  readonly active: boolean;
}

const CSS = `
canvas.companion {
  position: fixed; z-index: 40; top: calc(env(safe-area-inset-top, 0px) + 12px); left: 12px;
  border: 2px solid var(--cream, #f4ead5); background: var(--bg, #000); pointer-events: none;
  animation: companion-in 240ms var(--spring, cubic-bezier(.34, 1.56, .64, 1)) both;
}
@keyframes companion-in { from { transform: scale(.4); opacity: 0; } }
`;

export interface CompanionOptions {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  /** The robot's root (its feet) and the room it stands in (rotated so its floor is "down"). */
  robot: THREE.Object3D;
  room: THREE.Object3D;
  /** Restore the full-screen camera and canvas size. */
  restore: () => void;
  log?: (msg: string) => void;
}

/** Visible half-height around the robot's middle, in world units (the robot is 2.5 tall). */
const FRAME_HALF = 1.65;
const ROBOT_MID = 1.35;

export function createCompanion(o: CompanionOptions): Companion {
  if (!document.getElementById("companion-style")) {
    const style = document.createElement("style");
    style.id = "companion-style";
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  let active = false;
  let onIn = () => {}; // the pending "bubble in" log
  const up = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const dist = FRAME_HALF / Math.tan(THREE.MathUtils.degToRad(o.camera.fov / 2));

  function aim() {
    // "Up" is away from the current floor, so the robot stands upright in the bubble on any edge.
    o.room.getWorldQuaternion(q);
    up.set(0, 1, 0).applyQuaternion(q);
    o.robot.getWorldPosition(mid).addScaledVector(up, ROBOT_MID);
    o.camera.up.copy(up);
    o.camera.position.set(mid.x, mid.y, mid.z + dist);
    o.camera.lookAt(mid);
  }

  return {
    get active() {
      return active;
    },
    aim,
    enter() {
      if (active) return;
      active = true;
      o.renderer.setSize(BUBBLE_PX, BUBBLE_PX);
      o.camera.aspect = 1;
      o.camera.updateProjectionMatrix();
      const canvas = o.renderer.domElement;
      canvas.classList.add("companion");
      aim();
      o.log?.("companion bubble on");
      const t0 = performance.now();
      canvas.removeEventListener("animationend", onIn); // an earlier entry's pop never ended (page hidden): drop it
      onIn = () => o.log?.(`companion bubble in after ${Math.round(performance.now() - t0)} ms`);
      canvas.addEventListener("animationend", onIn, { once: true });
    },
    exit() {
      if (!active) return;
      active = false;
      o.renderer.domElement.classList.remove("companion");
      o.camera.up.set(0, 1, 0);
      o.restore();
      o.log?.("companion bubble off");
    },
  };
}
