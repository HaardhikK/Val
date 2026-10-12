// The 3D character: loads the model, blends its animations, and acts out gestures and physics.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { BodyState } from "./physics";
import { applyPinkLook, type EyeShine } from "./look";
import { createInstantCamera, createScroll, type FeatureProp } from "./props/featureProps";
import { restPose, stowLeft, revealDueMs, revealPose, type PropKind } from "./props/timeline";
import { ARMS, carryOver, copyGesturePose, GESTURES, gesturePose, restGesturePose, type ArmPose, type GestureName, type GesturePose } from "./gestures-anim";

export type Emote = "Wave" | "Yes" | "No" | "ThumbsUp" | "Jump" | "Punch";
type Loop = "Idle" | "Walking" | "Running" | "Dance";
type Mood = "Angry" | "Surprised" | "Sad";

/** revealing: pulling a prop from behind his back; holding: showing it while a feature is open. */
export type Mode = "normal" | "tumbling" | "sleeping" | "dancing" | "carried" | "falling" | "revealing" | "holding";

// Arm aims for the prop reveal, as directions in the body's frame (x: Val's left, y: up, z: towards you); each
// bone's own +y (towards its child) is swung onto the direction, keeping the clip's twist.
const AIM = {
  reachUpperR: new THREE.Vector3(-0.35, -0.75, -0.55).normalize(), // down and back
  reachLowerR: new THREE.Vector3(0.55, -0.35, -0.75).normalize(), // the hand behind the back
  holdUpperR: new THREE.Vector3(-0.3, -0.5, 0.8).normalize(), // elbows down, forearms forward
  holdLowerR: new THREE.Vector3(0.12, 0.35, 0.9).normalize(),
  holdUpperL: new THREE.Vector3(0.3, -0.5, 0.8).normalize(),
  holdLowerL: new THREE.Vector3(-0.12, 0.35, 0.9).normalize(),
};
/** Where the palm is along the forearm bone (bone-local units: the armature is tiny before the model's scale). */
const PALM = new THREE.Vector3(0, 0.017, 0);
/**
 * How far in front of the palms the held prop's middle sits: the camera's back rests against the hands; the scroll's
 * roll sits at the fingertips (at 0.2 it floated ahead of the hands during the turn; closer, a hand covered the map).
 */
const PROP_FORWARD: Record<PropKind, number> = { camera: 0.2, scroll: 0.1 };
// Scratch objects for the per-frame posing: no allocation per frame.
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _qBody = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _qWorld = new THREE.Quaternion();
const _qSwing = new THREE.Quaternion();
const _UP = new THREE.Vector3(0, 1, 0);
const _gaze = new THREE.Vector3();
const _euler = new THREE.Euler();
const _qOff = new THREE.Quaternion();
const _qTop = new THREE.Quaternion();
/** The reaction arm aims as vectors, built once: right arm as written, left mirrored. */
const ARM_AIMS = Object.fromEntries(
  (Object.keys(ARMS) as ArmPose[]).map((k) => {
    const v = (a: readonly number[], mirror: boolean) => new THREE.Vector3(mirror ? -a[0] : a[0], a[1], a[2]).normalize();
    return [k, { upperR: v(ARMS[k].upper, false), lowerR: v(ARMS[k].lower, false), upperL: v(ARMS[k].upper, true), lowerL: v(ARMS[k].lower, true) }];
  }),
) as Record<ArmPose, { upperR: THREE.Vector3; lowerR: THREE.Vector3; upperL: THREE.Vector3; lowerL: THREE.Vector3 }>;
const _vHead = new THREE.Vector3();
const _HEAD_UP = new THREE.Vector3(0, 0.45, 0);

const FADE = 0.25; // s crossfade between animations
/** The camera prop's flash burst (≥ 4 frames at the bubble's 30 fps). */
const FLASH_S = 0.15;
const HEIGHT = 2.5; // world units the model is scaled to

export class Character {
  readonly root = new THREE.Group(); // moved by physics (x, lean)
  private body = new THREE.Group(); // squash/stretch, facing and spin
  private mixer!: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private morphMeshes: THREE.Mesh[] = [];
  private head: THREE.Object3D | null = null;
  private headLook = new THREE.Quaternion();
  private headClipPose = new THREE.Quaternion();
  private headApplied = new THREE.Quaternion();
  private headWasApplied = false;
  private clingAmount = 0;
  private shine: EyeShine | null = null;
  private isTalking = false;
  private headTuck = 0; // 0..1: head tucked down (peekaboo)
  private pace = 1; // idle animation speed (sleepy in the dark)
  private lookTarget: THREE.Vector3 | null = null;
  private epoch = 0;
  private moodEpoch = 0;
  private moodTarget: Partial<Record<Mood, number>> = {};
  private facing = 0;
  private squash = 0; // spring offset, 0 = rest
  private squashVel = 0;
  private spinLeft = 0;
  private busyUntil = 0; // ms; an emote or tumble is playing until then
  private clock = 0; // s since start
  private arms: { upperR: THREE.Object3D; lowerR: THREE.Object3D; upperL: THREE.Object3D; lowerL: THREE.Object3D } | null = null;
  private props: Partial<Record<PropKind, FeatureProp>> = {};
  private held: FeatureProp | null = null; // the prop in his hands (also while it is being put away)
  private revealStart = 0;
  private revealDone: (() => void) | null = null;
  private pose = restPose();
  private stowAt = -1; // wall-clock ms the prop started going away (-1: not stowing)
  private flashLeft = 0; // s left of the camera prop's flash burst
  private gazeAt = new THREE.Vector3();
  // The current reaction (gestures-anim.ts): a newer one replaces it; its pose is recomputed each frame.
  private gName: GestureName | null = null;
  private gStart = 0;
  private gReleased: number | null = null;
  private gLast = -1; // ms into the gesture at the last frame (clip and kick cues fire once when crossed)
  private gPose = restGesturePose();
  private gFrom = restGesturePose(); // the cut-off reaction's last pose, fading out under the new one
  private gCarry = 0;
  private armBase = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
  private armsAimed = false;
  private gAfterWake: GestureName | null = null;
  /** Bumped by every new reaction: timers (sparkles) for an older one check it. */
  gestureId = 0;
  mode: Mode = "normal";
  /** Called once a prop is fully put away (for the phone log). */
  onStowed?: (kind: PropKind) => void;

  async load(url: string, parent: THREE.Object3D) {
    const gltf = await new GLTFLoader().loadAsync(url);
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    model.scale.setScalar(HEIGHT / size.y);
    model.position.y = -box.min.y * (HEIGHT / size.y);
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.morphTargetDictionary && m.morphTargetInfluences) this.morphMeshes.push(m);
    });
    this.shine = applyPinkLook(model);
    this.head = model.getObjectByName("Head") ?? null;
    // The GLB's "UpperArm.R" etc.: three.js drops the "." from node names.
    const [upperR, lowerR, upperL, lowerL] = ["UpperArmR", "LowerArmR", "UpperArmL", "LowerArmL"].map((n) => model.getObjectByName(n));
    if (upperR && lowerR && upperL && lowerL) this.arms = { upperR, lowerR, upperL, lowerL };
    this.body.add(model);
    this.root.add(this.body);
    this.root.add(blobShadow());
    parent.add(this.root);

    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) {
      const a = this.mixer.clipAction(clip);
      if (["Death", "Sitting", "Standing", "Wave", "Yes", "No", "ThumbsUp", "Jump", "Punch"].includes(clip.name)) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      this.actions.set(clip.name, a);
    }
    this.play("Idle", 0);
    this.emote("Wave"); // hello
  }

  get animation() {
    return this.current?.getClip().name ?? "none";
  }

  private play(name: string, fade = FADE) {
    const next = this.actions.get(name);
    if (!next || next === this.current) return;
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    this.current?.fadeOut(fade);
    this.current = next;
  }

  private busy(nowMs: number) {
    return nowMs < this.busyUntil;
  }

  private holdFor(name: string, nowMs: number, extra = 0) {
    const clip = this.actions.get(name)?.getClip();
    this.busyUntil = nowMs + ((clip?.duration ?? 1) * 1000 + extra);
  }

  emote(name: Emote, nowMs = performance.now()) {
    if (this.mode !== "normal" || this.busy(nowMs)) return;
    this.play(name, 0.15);
    this.holdFor(name, nowMs);
  }

  mood(m: Mood, amount: number) {
    this.moodTarget = { [m]: amount };
    this.moodEpoch++;
  }

  /** Show a mood for a moment, then relax, unless another mood was set meanwhile. */
  pulseMood(m: Mood, amount: number, ms: number) {
    this.mood(m, amount);
    const e = this.moodEpoch;
    setTimeout(() => {
      if (this.moodEpoch === e) this.mood(m, 0);
    }, ms);
  }

  /**
   * Put a prop built in world units on the front of the eyes (sunglasses: see createSunglasses), sized to the eyes.
   * Returns null before load.
   */
  seatOnEyes(build: (spacing: number) => THREE.Object3D): THREE.Object3D | null {
    if (!this.shine) return null;
    const prop = build(this.shine.spacing);
    this.shine.seat(prop);
    return prop;
  }

  /** World position just above the head (for stars and hearts); pass `out` to avoid an allocation per call. */
  headTop(out = new THREE.Vector3()): THREE.Vector3 {
    (this.head ?? this.root).getWorldPosition(out);
    return out.add(_vHead.copy(_HEAD_UP).applyQuaternion(this.root.getWorldQuaternion(_qTop)));
  }

  /**
   * Compile the feature props' GPU programs once, in idle time after load, so the first camera or map reveal does
   * not stall on a shader compile (≈ 100+ ms on the phone). The props are made visible for the compile only and
   * hidden again before anything is drawn. Their textures upload separately (warmTextures).
   */
  warmUp(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const props = this.warmProps();
    for (const prop of props) {
      if (!prop.group.parent) this.body.add(prop.group);
      prop.group.visible = true;
      prop.setAction(1); // the scroll's sheet shows
      prop.flash?.(1); // the camera's glint shows
    }
    renderer.compile(scene, camera);
    for (const prop of props) {
      prop.group.visible = false;
      prop.setAction(0);
      prop.flash?.(0);
    }
  }

  /** Upload the feature props' textures once (after warmUp), so the first reveal does not wait for them. */
  warmTextures(renderer: THREE.WebGLRenderer) {
    for (const prop of this.warmProps()) {
      prop.group.traverse((o) => {
        const map = ((o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined)?.map;
        if (map) renderer.initTexture(map);
      });
    }
  }

  private warmProps() {
    return (["camera", "scroll"] as const).map((kind) => (this.props[kind] ??= kind === "camera" ? createInstantCamera() : createScroll()));
  }

  /** Change mode and invalidate every timer started under the previous mode. */
  private enter(mode: Mode) {
    this.mode = mode;
    this.epoch++;
    return this.epoch;
  }

  /** Run fn later only if nothing changed the mode in between. */
  private later(ms: number, fn: () => void) {
    const e = this.epoch;
    setTimeout(() => {
      if (this.epoch === e) fn();
    }, ms);
  }

  startFall() {
    if (this.mode === "sleeping" || this.mode === "carried") return false;
    this.enter("falling");
    this.mood("Surprised", 1);
    this.play("Jump", 0.1);
    return true;
  }

  land() {
    if (this.mode !== "falling") return;
    this.enter("normal");
    this.kick(0.3);
    this.mood("Surprised", 0);
    this.busyUntil = 0;
    this.later(300, () => this.emote("Yes")); // "phew"
  }

  /** Clinging to the edge while the phone is held sideways (0 = not, 1 = about to fall). */
  cling(progress: number) {
    this.clingAmount = progress;
  }

  tumble(nowMs = performance.now()) {
    if (this.mode !== "normal" && this.mode !== "dancing") return; // not while carried, falling, asleep or already tumbling
    this.enter("tumbling");
    this.mood("Surprised", 1);
    this.play("Death", 0.1);
    this.kick(0.25);
    this.busyUntil = nowMs + 2600;
    this.later(1400, () => {
      this.play("Standing", 0.3);
      this.mood("Sad", 0.5); // dizzy
      this.later(1100, () => {
        this.enter("normal");
        this.mood("Sad", 0);
        this.busyUntil = 0;
      });
    });
  }

  /**
   * Pull a prop from behind the back and show it (camera: held towards you; scroll: unroll). Resolves when the
   * feature may open, or at once when something else interrupts it (any mode change). He keeps holding it until
   * stow(). It finishes on time even when no frame is drawn; callers still cap the wait (REVEAL.maxMs).
   */
  reveal(kind: PropKind, nowMs = performance.now()): Promise<void> {
    this.revealDone?.(); // an older reveal gives way
    if (!this.arms) return Promise.resolve();
    const prop = (this.props[kind] ??= kind === "camera" ? createInstantCamera() : createScroll());
    if (this.held && this.held !== prop) {
      this.held.group.visible = false; // the old prop was still going away: gone now
      this.onStowed?.(this.held.kind);
    }
    if (!prop.group.parent) this.body.add(prop.group);
    prop.group.visible = false;
    prop.setAction(0);
    this.held = prop;
    this.stowAt = -1;
    this.spinLeft = 0;
    this.busyUntil = 0;
    this.mood("Surprised", 0);
    this.revealStart = nowMs;
    this.enter("revealing");
    this.play("Idle", 0.2);
    // Drawn frames finish the reveal on time, but frames can stop (a permission dialog pauses the WebView, the page
    // is hidden, drawing is paused): the wall clock finishes it too, so he is "holding" (and looks at the scroll)
    // the moment the pose is done, whether or not a frame saw it.
    this.later(revealDueMs(kind), () => this.finishReveal());
    return new Promise((resolve) => {
      this.revealDone = () => {
        this.revealDone = null;
        resolve();
      };
    });
  }

  /** The reveal pose is done: hold the prop, and let the feature open. */
  private finishReveal() {
    if (this.mode !== "revealing") return;
    this.enter("holding");
    this.revealDone?.();
  }

  /** Put the prop away (the feature closed): it shrinks back into his hands and the arms relax. */
  stow() {
    this.revealDone?.();
    if (this.mode !== "revealing" && this.mode !== "holding") return;
    this.enter("normal");
    this.busyUntil = 0;
    this.flashLeft = 0;
    this.play("Idle", 0.25); // a crossfade back to idle (a no-op when idle is already playing)
  }

  /**
   * A photo: the camera in his hands flashes (the glint on its flash window) and his arms recoil a little. Lasts
   * FLASH_S, i.e. 4–5 frames even in the 30 fps corner bubble. Only while holding the camera.
   */
  flash() {
    if (this.mode !== "holding" || this.held?.kind !== "camera") return false;
    this.flashLeft = FLASH_S;
    return true;
  }

  /** World position of the held prop (its gaze point: the scroll's sheet, the camera's middle); false if none. */
  propAnchor(out: THREE.Vector3): boolean {
    if (!this.held || !this.held.group.visible) return false;
    this.held.group.updateWorldMatrix(true, false);
    out.copy(this.held.gaze);
    this.held.group.localToWorld(out);
    return true;
  }

  sleep() {
    if (this.mode === "sleeping" || this.mode === "falling" || this.mode === "carried") return false;
    if (this.mode === "revealing" || this.mode === "holding") return false; // a feature is opening or open
    this.enter("sleeping");
    this.play("Sitting", 0.5);
    this.mood("Sad", 0.25);
    return true;
  }

  wake(nowMs = performance.now()) {
    if (this.mode !== "sleeping") return;
    this.enter("normal");
    this.mood("Sad", 0);
    this.play("Standing", 0.3);
    this.holdFor("Standing", nowMs);
    const standing = (this.actions.get("Standing")?.getClip().duration ?? 1) * 1000;
    this.later(standing + 50, () => {
      const g = this.gAfterWake;
      this.gAfterWake = null;
      if (!g || !this.gesture(g)) this.emote("Wave");
    });
  }

  dance(nowMs = performance.now()) {
    if (this.mode !== "normal") return;
    this.enter("dancing");
    this.play("Dance", 0.2);
    this.busyUntil = nowMs + 4000;
    this.later(4000, () => this.enter("normal"));
  }

  spin(nowMs = performance.now()) {
    if (this.mode !== "normal") return;
    this.spinLeft = Math.PI * 2;
    this.play("Jump", 0.1);
    this.holdFor("Jump", nowMs);
  }

  /**
   * A short reaction (gestures-anim.ts) on top of the idle clip; a newer one cancels an older one. Only in normal
   * mode: never while a feature's prop is revealed or held, falling, tumbling, carried or dancing. Asleep, he wakes
   * up first and reacts once he stands. Returns the reaction's id (for its timed effects), or 0 when it did not play.
   */
  gesture(name: GestureName, nowMs = performance.now()): number {
    if (this.mode === "sleeping") {
      this.wake(nowMs);
      this.gAfterWake = name;
      return 0;
    }
    if (this.mode !== "normal") return 0;
    const spec = GESTURES[name];
    if (this.gName) copyGesturePose(this.gPose, this.gFrom);
    else restGesturePose(this.gFrom);
    this.gName = name;
    this.gStart = nowMs;
    this.gReleased = null;
    this.gLast = -1;
    this.spinLeft = 0;
    // A clip must not be swapped for the walk/idle loop while it plays; a pose-only reaction leaves the loop alone.
    let clipEnd = 0;
    for (const [at, clip] of spec.clips ?? []) clipEnd = Math.max(clipEnd, at + (this.actions.get(clip)?.getClip().duration ?? 1) * 1000);
    this.busyUntil = clipEnd ? nowMs + Math.max(clipEnd, spec.ms) : 0;
    if (spec.mood) this.pulseMood(spec.mood[0], spec.mood[1], spec.ms);
    return ++this.gestureId;
  }

  /** Let go of a held reaction (the thinking pose); with no name, of whatever reaction plays or waits. */
  endGesture(name?: GestureName, nowMs = performance.now()) {
    if (!name || name === this.gAfterWake) this.gAfterWake = null;
    if (this.gName && (!name || name === this.gName) && this.gReleased === null) this.gReleased = nowMs;
  }

  /** The reaction now playing (debug), or null. */
  get currentGesture() {
    return this.gName;
  }

  /** This frame's reaction pose; clip and squash cues fire as their times pass. Ends it when its time is up. */
  private updateGesture(nowMs: number) {
    const name = this.gName;
    if (!name) return;
    // Another mode took over (a reveal, a fall, a tumble, sleep): ease out at once, and no further cues.
    if (this.mode !== "normal" && this.gReleased === null) this.gReleased = nowMs;
    const t = nowMs - this.gStart;
    const spec = GESTURES[name];
    if (spec.hold && this.gReleased === null && t >= spec.ms) this.gReleased = nowMs; // never held forever
    if (this.gReleased === null) {
      for (const [at, clip] of spec.clips ?? []) if (at > this.gLast && at <= t) this.play(clip, 0.15);
      for (const [at, amount] of spec.kicks ?? []) if (at > this.gLast && at <= t) this.kick(amount);
    }
    this.gLast = t;
    if (!gesturePose(name, t, this.gReleased === null ? null : nowMs - this.gReleased, this.gPose)) {
      this.gName = null;
      this.gCarry = 0;
      return;
    }
    this.gCarry = carryOver(t, this.gFrom, this.gPose);
  }

  /** The reaction's arms, after the clip and the prop (never while a prop is in his hands). */
  private updateGestureArms() {
    if (!this.arms || this.held || !this.gName) return;
    this.saveArms();
    this.body.getWorldQuaternion(_qBody);
    if (this.gCarry > 0) this.poseArms(this.gFrom, this.gFrom.arm * this.gCarry);
    this.poseArms(this.gPose, this.gPose.arm);
  }

  /**
   * Remember the clip's arm pose before aiming the arms (a reaction or a held prop). Idle, Yes and No never key the
   * arm bones, so without this an aim sticks after it ends (Val kept the camera pose until a walk clip reset it).
   */
  private saveArms() {
    if (this.armsAimed || !this.arms) return;
    const { upperR, lowerR, upperL, lowerL } = this.arms;
    this.armBase[0].copy(upperR.quaternion);
    this.armBase[1].copy(lowerR.quaternion);
    this.armBase[2].copy(upperL.quaternion);
    this.armBase[3].copy(lowerL.quaternion);
    this.armsAimed = true;
  }

  /** Undo last frame's arm aims (reaction or prop) before the mixer runs, so a clip that does not key the arms starts clean. */
  private restoreArms() {
    if (!this.armsAimed || !this.arms) return;
    this.armsAimed = false;
    this.arms.upperR.quaternion.copy(this.armBase[0]);
    this.arms.lowerR.quaternion.copy(this.armBase[1]);
    this.arms.upperL.quaternion.copy(this.armBase[2]);
    this.arms.lowerL.quaternion.copy(this.armBase[3]);
  }

  private poseArms(g: GesturePose, w: number) {
    if (!this.arms || w < 0.001) return;
    const { upperR, lowerR, upperL, lowerL } = this.arms;
    if (g.armR) {
      aimBone(upperR, ARM_AIMS[g.armR].upperR, w);
      aimBone(lowerR, ARM_AIMS[g.armR].lowerR, w);
    }
    if (g.armL) {
      aimBone(upperL, ARM_AIMS[g.armL].upperL, w);
      aimBone(lowerL, ARM_AIMS[g.armL].lowerL, w);
    }
  }

  /** Turn the head towards a world point (a finger); null looks back at the viewer. */
  lookAt(target: THREE.Vector3 | null) {
    this.lookTarget = target;
  }

  /** Speaking: a gentle head bob while the voice plays. */
  talking(on: boolean) {
    this.isTalking = on;
  }

  /** Tuck the head down to hide (peekaboo); 0 = normal. */
  tuckHead(amount: number) {
    this.headTuck = THREE.MathUtils.clamp(amount, 0, 1);
  }

  /** Idle animation speed (1 = normal); emotes always play at full speed so their timing holds. */
  setPace(k: number) {
    this.pace = THREE.MathUtils.clamp(k, 0.3, 1.5);
  }

  /** A happy little hop (tap reaction). */
  hop(nowMs = performance.now()) {
    if (this.mode !== "normal" || this.busy(nowMs)) return;
    this.play("Jump", 0.1);
    this.holdFor("Jump", nowMs);
    this.kick(0.25);
  }

  setCarried(on: boolean) {
    if (on && this.mode === "normal") {
      this.enter("carried");
      this.play("Jump", 0.1);
      this.mood("Surprised", 0.25);
    } else if (!on && this.mode === "carried") {
      this.enter("normal");
      this.mood("Surprised", 0);
      this.busyUntil = 0;
      this.kick(0.22); // land with a squash
    }
  }

  /** A squash-and-stretch impulse: positive squashes down, then springs back. */
  kick(amount: number) {
    this.squashVel -= amount * 12;
  }

  /**
   * Small head motion on top of the clip's pose (a nod while speaking), applied fresh each frame,
   * never on top of last frame's result.
   */
  private updateHead(dt: number) {
    if (!this.head) return;
    const head = this.head;
    // If the clip did not write the head this frame, it still holds what we applied last frame: keep the stored pose.
    if (!(this.headWasApplied && head.quaternion.equals(this.headApplied))) this.headClipPose.copy(head.quaternion);
    let yaw = 0;
    let pitch = 0;
    // Holding the unrolled scroll, he looks down at it (unless a finger is steering his head).
    const gaze = this.lookTarget ?? (this.mode === "holding" && this.held?.kind === "scroll" && this.propAnchor(this.gazeAt) ? this.gazeAt : null);
    if (gaze) {
      const local = head.parent!.worldToLocal(_gaze.copy(gaze));
      yaw = THREE.MathUtils.clamp(Math.atan2(local.x - head.position.x, 3), -0.5, 0.5);
      pitch = THREE.MathUtils.clamp(-Math.atan2(local.y - head.position.y, 4), -0.3, 0.3);
    }
    if (this.isTalking) pitch += Math.sin(this.clock * 9) * 0.06; // nods along while it speaks
    pitch += this.headTuck * 0.55;
    const g = this.gPose; // a reaction's head turn, on top
    _qOff.setFromEuler(_euler.set(pitch + g.pitch, yaw + g.yaw, g.roll));
    this.headLook.slerp(_qOff, Math.min(dt * (this.gName ? 9 : 5), 1));
    head.quaternion.copy(this.headClipPose).multiply(this.headLook);
    this.headApplied.copy(head.quaternion);
    this.headWasApplied = true;
  }

  /**
   * The prop reveal on top of the clip: arms swung towards the reach or hold aims (fresh each frame, after the
   * mixer), the prop placed in the hands and turned to face the viewer.
   */
  private updateProp(dt: number, nowMs: number) {
    const prop = this.held;
    if (!prop || !this.arms) return;
    const p = this.pose;
    if (this.mode === "revealing") {
      // The pose itself was computed with the facing, earlier in this frame.
      if (p.ready) this.finishReveal();
    } else if (this.mode === "holding") {
      p.reach = 0;
      p.hold = 1;
      p.propScale = 1;
      p.propTurn = 1;
      p.action = 1;
    } else {
      this.flashLeft = 0;
      // Put away (stow(), or another mode took over): shrink, roll up and relax the arms together, on the wall
      // clock (a frame after a long pause finishes it at once instead of resuming half-way).
      this.revealDone?.();
      if (this.stowAt < 0) this.stowAt = nowMs;
      const k = prop.group.visible ? stowLeft(nowMs - this.stowAt) : 0;
      p.reach = 0;
      p.hold = Math.min(p.hold, k);
      p.propScale = Math.min(p.propScale, k);
      p.action = Math.min(p.action, k);
      if (k <= 0) {
        prop.group.visible = false;
        prop.setAction(0);
        prop.flash?.(0);
        this.held = null;
        this.stowAt = -1;
        this.onStowed?.(prop.kind);
        return;
      }
    }

    // The flash burst: 1 → 0; the arms pull back a touch (less "hold") and the camera kicks up and back.
    const burst = this.flashLeft > 0 ? this.flashLeft / FLASH_S : 0;
    this.flashLeft = Math.max(0, this.flashLeft - dt);
    if (burst > 0) p.hold = 1 - 0.3 * burst;
    prop.flash?.(burst);

    const { upperR, lowerR, upperL, lowerL } = this.arms;
    this.body.getWorldQuaternion(_qBody);
    if (p.reach > 0.001 || p.hold > 0.001) this.saveArms();
    if (p.reach > 0.001) {
      aimBone(upperR, AIM.reachUpperR, p.reach);
      aimBone(lowerR, AIM.reachLowerR, p.reach);
    }
    if (p.hold > 0.001) {
      aimBone(upperR, AIM.holdUpperR, p.hold);
      aimBone(lowerR, AIM.holdLowerR, p.hold);
      aimBone(upperL, AIM.holdUpperL, p.hold);
      aimBone(lowerL, AIM.holdLowerL, p.hold);
    }

    // In the right hand while it comes round, then between both hands.
    const g = prop.group;
    g.visible = p.propScale > 0.01;
    if (!g.visible) return;
    lowerR.updateWorldMatrix(true, false);
    lowerR.localToWorld(_v.copy(PALM));
    if (p.hold > 0.001) {
      lowerL.updateWorldMatrix(true, false);
      lowerL.localToWorld(_v2.copy(PALM));
      _v.lerp(_v2.add(_v).multiplyScalar(0.5), p.hold);
    }
    this.body.worldToLocal(_v);
    g.position.copy(_v);
    g.position.z += PROP_FORWARD[prop.kind] * p.hold;
    if (prop.kind === "scroll") g.position.y += 0.12 * p.hold; // the roll at the hands, the sheet hanging below
    g.rotation.set(-0.1 * p.hold - 0.35 * burst, Math.PI * (1 - p.propTurn), 0);
    g.scale.setScalar(p.propScale);
    prop.setAction(p.action);
  }

  update(dt: number, nowMs: number, body: BodyState, lift: number) {
    this.clock += dt;
    this.restoreArms();
    this.mixer.update(this.current === this.actions.get("Idle") ? dt * this.pace : dt);

    this.updateGesture(nowMs);
    this.updateHead(dt);

    // Locomotion animation follows speed, unless something else is playing.
    if (this.mode === "normal" && !this.busy(nowMs)) {
      const speed = Math.abs(body.vx);
      const loop: Loop = speed < 0.12 ? "Idle" : speed < 0.9 ? "Walking" : "Running";
      this.play(loop);
    }

    // Face the way it moves, otherwise turn back towards the viewer.
    const moving = this.mode === "normal" && Math.abs(body.vx) > 0.12;
    const targetFacing = moving ? Math.sign(body.vx) * 1.1 : 0;
    this.facing += (targetFacing - this.facing) * Math.min(dt * 6, 1);
    if (this.mode === "revealing" && this.held) this.facing = revealPose(this.held.kind, nowMs - this.revealStart, this.pose).yaw;

    if (this.spinLeft > 0) {
      const s = Math.min(this.spinLeft, dt * 9);
      this.spinLeft -= s;
      this.facing += s;
      if (this.spinLeft <= 0) this.facing %= Math.PI * 2;
    }

    // Spring for squash and stretch.
    this.squashVel += (-120 * this.squash - 14 * this.squashVel) * dt;
    this.squash += this.squashVel * dt;
    const breathe = this.mode === "sleeping" ? 0.02 * Math.sin(this.clock * 1.6) : 0.008 * Math.sin(this.clock * 2.4);
    const g = this.gPose;
    const sy = (1 - this.squash + breathe) * (1 + g.stretch);
    const sxz = (1 + this.squash * 0.5) * (1 - g.stretch * 0.4);

    if (this.mode !== "falling") {
      this.root.position.x = body.x;
      this.root.rotation.z = this.mode === "carried" ? body.lean * 0.3 : body.lean;
    }
    this.body.position.y = lift + g.lift;
    this.body.rotation.x = g.lean;
    this.body.rotation.y = this.facing;
    this.body.scale.set(sxz, sy, sxz);

    // Clinging to the edge before a fall: crouches a little (no trembling: it read as glitchy).
    if (this.clingAmount > 0 && this.mode === "normal") this.body.scale.y *= 1 - 0.06 * this.clingAmount;

    this.updateProp(dt, nowMs);
    this.updateGestureArms();

    // Ease face expressions.
    for (const mesh of this.morphMeshes) {
      const dict = mesh.morphTargetDictionary!;
      const inf = mesh.morphTargetInfluences!;
      for (const name of Object.keys(dict) as Mood[]) {
        const target = this.moodTarget[name] ?? 0;
        inf[dict[name]] += (target - inf[dict[name]]) * Math.min(dt * 5, 1);
      }
    }
    // The eye highlights ride on the eye surface, so they follow the expression just set.
    this.shine?.update();
  }
}

/**
 * Swing a bone so its +y axis (towards its child) points along `dirBody` (in the body's frame, rotated by the
 * body's world rotation _qBody), blended by `weight` from the pose it already has this frame.
 */
function aimBone(bone: THREE.Object3D, dirBody: THREE.Vector3, weight: number) {
  const parent = bone.parent!;
  parent.updateWorldMatrix(true, false);
  parent.getWorldQuaternion(_qParent);
  _qWorld.copy(_qParent).multiply(bone.quaternion);
  _v.copy(_UP).applyQuaternion(_qWorld);
  _dir.copy(dirBody).applyQuaternion(_qBody);
  _qSwing.setFromUnitVectors(_v, _dir).multiply(_qWorld); // the aimed world rotation
  _qWorld.copy(_qParent).invert().multiply(_qSwing); // back to the bone's local frame
  bone.quaternion.slerp(_qWorld, weight);
}

/** A soft round shadow under the feet: much cheaper than real shadow maps on an old GPU. */
function blobShadow() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,200,230,0.3)"); // a faint glow under the feet (a dark shadow is invisible on black)
  grad.addColorStop(1, "rgba(255,200,230,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 0.7),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.01;
  return mesh;
}
