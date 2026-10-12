// Entry point: scene, render loop, and wiring of motion, gestures, touch and physics to the character.
import * as THREE from "three";
import { Bridge, type ButtonName, type SensorEvent, type VisionEvent, type VoiceEvent } from "./bridge";
import { Character, type Emote } from "./character";
import { GESTURES, reactionFor, type GestureName } from "./gestures-anim";
import { GestureDetector, type Gesture, type MotionSample } from "./gestures";
import { answerReply, answerWait, fallbackReply, guessLine, localNotes, photoCaption, respond, WARMING_LINE, WARMING_TIMEOUT_MS, type Command } from "./assistant";
import { CREAM, Effects, PINK } from "./effects";
import { FLOOR_ANGLE, FloorPicker, alongFloor, cornerFloor, type Floor } from "./floors";
import { restingBody, step } from "./physics";
import { TRACES } from "./traces";
import { createReactions } from "./delight/reactions";
import { createCamera } from "./camera/camera";
import { createMap } from "./map";
import { createVoiceHud, voiceSetting } from "./hud";
import { createLantern, createSunglasses } from "./delight/props";
import { createSunCard } from "./delight/sunCard";
import { createCompanion, frameGap, idleCap } from "./companion";
import { easeOut, REVEAL, rightingAngle, type PropKind } from "./props/timeline";
import {
  featureBusy,
  featureLabel,
  featureStep,
  homeState,
  mustBeDown,
  type FeatureEffect,
  type FeatureEvent,
  type FeatureKind,
  type FeatureRequest,
  type FeatureState,
} from "./features";
import { createMeter, createMetalLogic as createMetal } from "./metal";
import { glanceDir, knockReaction, type KnockSide } from "./knock";
import { createSeismograph } from "./delight/seismograph";
import { createTimer, doneLine } from "./timer";
import { DEVICE, pixelRatio } from "./device";
import { FIX_WAIT_MS, LINES as TRIP_LINES, Locator, loadHome, locateLine, saveHome } from "./transit/trip";

const params = new URLSearchParams(location.search);
const debug = params.has("debug");

const message = document.getElementById("message")!;
const say = (text: string) => {
  if (text) message.textContent = text; // an empty line fades the old one out (index.html) instead of blanking it
  message.style.opacity = text ? "1" : "0";
};
say("Val is waking up…");
let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 1); // opaque black: cheaper to composite than a transparent canvas
} catch (err) {
  say("Val can't draw on this screen (3D graphics unavailable).");
  throw err;
}
renderer.debug.checkShaderErrors = debug; // the per-program error check stalls each compile; only when debugging
renderer.setPixelRatio(pixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
if (debug) (window as unknown as { charmScene: THREE.Scene }).charmScene = scene;
// Lit for a black background: soft fill from the front, and a warm cream rim light from behind so the edges glow.
scene.add(new THREE.HemisphereLight(0xfff4ee, 0x3a3836, 2.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(2, 5, 4);
scene.add(sun);
const rim = new THREE.DirectionalLight(0xffe9c8, 1.4);
rim.position.set(-3, 3, -4);
scene.add(rim);

// The camera looks straight at the screen centre; every screen edge can be a floor (floors.ts).
const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
const HALF_WIDTH = 2.5; // visible half-width in world units (the character is 2.1 units tall)
let halfHeight = 5;
function fitCamera() {
  const aspect = window.innerWidth / window.innerHeight;
  camera.aspect = aspect;
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  halfHeight = HALF_WIDTH / aspect;
  camera.position.set(0, 0, halfHeight / Math.tan(halfFov));
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
function onResize() {
  if (!companion.active) fitCamera(); // in the bubble the size is fixed; exit() refits
}
/** Distance from the screen centre to the floor surface. */
// Bottom and top floors sit well inside the screen (the character stays clear of the edge).
const floorDist = (f: Floor) => (f === "bottom" || f === "top" ? halfHeight * 0.6 : HALF_WIDTH - 0.45);
/** How far the character can walk along that floor. */
// Keep the whole body (about 1.3 units wide with arms) inside the screen with a gap.
const floorHalf = (f: Floor) => (f === "bottom" || f === "top" ? HALF_WIDTH - 1.3 : halfHeight * 0.6 - 1.4);
fitCamera();
window.addEventListener("resize", onResize);

const room = new THREE.Group(); // rotated so the current floor is "down"
scene.add(room);
const bridge = new Bridge();
// Sensor readings arrive from the start, before the model has loaded: keep the latest of each kind and replay them
// into the reactions once they exist (wireSensors), so a bright room at start-up still gets the sunglasses.
const latestSensor = new Map<SensorEvent["type"], SensorEvent>();
let sensorSink: ((e: SensorEvent) => void) | null = null;
bridge.onSensor((e) => {
  latestSensor.set(e.type, e);
  sensorSink?.(e);
});
const character = new Character();
character.onStowed = (kind) => log(`stow done ${kind}`);
const companion = createCompanion({ renderer, camera, robot: character.root, room, restore: fitCamera, log: (m) => log(m) });
const sunCard = createSunCard();
const effects = new Effects(scene);
/** The point above Val's head, for effects that follow it every frame (read at once: a shared scratch vector). */
const _headNow = new THREE.Vector3();
const headNow = () => character.headTop(_headNow);
const picker = new FloorPicker();
let floor: Floor = "bottom";
let gravityText = "";
let lastGravityLog = 0;
let gravity: [number, number, number] = [0, 9.81, 0];
let fall: { from: THREE.Vector3; to: THREE.Vector3; a0: number; a1: number; t: number; x1: number } | null = null;
/** Turning the room back to the bottom floor before a feature opens: from angle a0 and floor distance d0. */
let righting: { a0: number; d0: number; t0: number } | null = null;
const detector = new GestureDetector();
let body = restingBody();
let lastSampleAt = 0;
let walkTarget: number | null = null;
let nextWanderAt = performance.now() + 3000;
let nextClingTick = 0;
let nextZzz = 0;
let carriedX: number | null = null;
/** Last pointer activity on the stage (the idle frame cap waits IDLE_TOUCH_MS after it). */
let lastTouchAt = 0;
/** Scratch for the fall's per-frame position. */
const _fallAt = new THREE.Vector3();

const status = document.getElementById("status")!;
const log = (msg: string) => {
  console.log(`charm:${msg}`);
  if (debug) status.textContent = msg;
};

// Motion samples → physics input and gestures.
bridge.onSample((s: MotionSample) => {
  lastSampleAt = performance.now();
  gravity = s.gravity;
  if (debug) gravityText = `g ${s.gravity.map((v) => v.toFixed(1)).join(" ")}`;
  for (const g of detector.push(s)) onGesture(g);
});

// ---- Voice: listening → heard → command → speaking (all on the phone, offline) ----
const hud = createVoiceHud();
const voice = voiceSetting();
hud.setMuted(!voice.on);
const notes = localNotes();

// Speaking a reply: the text is typed only once the voice starts, in time with each spoken chunk. If no audio comes
// within VOICE_LATE_MS (or the voice fails, or is off), the reply is typed the normal way instead.
const VOICE_LATE_MS = 1500; // the offline system voice starts in ~0.25 s; only the slow fallback voice is ever this late
let lateTimer: number | undefined;
let speakGuard: number | undefined;
let sayAt = 0;
/**
 * Val says a line. Never over a feature's own transition (its prop beat, the shutter, the map growing): while one is
 * revealing or closing, the line waits and is said the moment it ends. Empty lines (opening the camera) are silent.
 */
let deferredSay: [string, string, number | undefined, boolean] | null = null;
/** `error`: the line says something went wrong (a small pink tag on the card). */
function sayReply(heard: string, reply: string, holdMs?: number, error = false) {
  if (!reply) return;
  if (fs.phase === "revealing" || fs.phase === "closing") {
    deferredSay = [heard, reply, holdMs, error];
    log(`say deferred (${featureLabel(fs)})`);
    return;
  }
  speakNow(heard, reply, holdMs, error);
}
function flushSay() {
  if (!deferredSay) return;
  const [heard, reply, holdMs, error] = deferredSay;
  deferredSay = null;
  log("say (deferred line, transition ended)");
  speakNow(heard, reply, holdMs, error);
}
function speakNow(heard: string, reply: string, holdMs?: number, error = false) {
  hud.setFact(false);
  hud.setError(error);
  clearTimeout(lateTimer);
  if (!voice.on) {
    if (heard) bridge.send({ type: "said", text: reply });
    hud.show(heard, reply, holdMs);
    return;
  }
  hud.prepare(heard, reply);
  hud.setEars("thinking"); // the first chunk is being made
  sayAt = performance.now();
  bridge.send({ type: "say", text: reply, reply: heard !== "" });
  lateTimer = window.setTimeout(() => {
    lateTimer = undefined;
    if (!hud.typeNow(holdMs)) return;
    if (hud.ears === "thinking") hud.setEars("off");
    log(`voice late: no audio after ${VOICE_LATE_MS} ms, text only`);
  }, VOICE_LATE_MS);
}
// The countdown round the screen edge (timer.ts). At zero: a dance, hearts and the spoken line.
const clock = createTimer({
  send: (e) => bridge.send(e),
  log: (m) => log(m),
  onDone: (label, focus) => {
    character.dance();
    effects.hearts(character.headTop(), 6);
    sayReply("", doneLine(label, focus));
    bridge.send({ type: "haptic", pattern: "giggle" });
  },
});
let levels = 0;
let listenStart = 0;

/** While listening the head tilts a little up and aside, as if lending an ear; null looks back. */
function lendEar(on: boolean) {
  if (pressStart) return; // a finger is steering the head
  character.lookAt(on ? character.headTop().add(new THREE.Vector3(0.9, 0.5, 2.5)) : null);
}

// Val's little reaction to a command or answer (gestures-anim.ts): a pose, maybe a clip, and its sparkles on time.
const fxAt = new THREE.Vector3();
/** Where pops float up from: well clear of the dome (headTop() sits inside the big head). */
const overHead = () => {
  character.headTop(fxAt).y += 1.3;
  return fxAt;
};
function react(name: GestureName): boolean {
  if (character.mode === "sleeping") {
    character.gesture(name); // wakes up first, reacts once standing
    bridge.send({ type: "screen", mode: "awake" });
    log(`react ${name} (after waking)`);
    return true;
  }
  const id = character.gesture(name);
  if (!id) {
    log(`react ${name} skipped (${character.mode})`);
    return false;
  }
  log(`react ${name}`);
  walkTarget = null; // he stops wandering to react
  for (const fx of GESTURES[name].fx ?? []) {
    window.setTimeout(() => {
      if (character.gestureId !== id || character.currentGesture !== name) return; // replaced or cut off meanwhile
      if (fx.kind === "twinkles") effects.twinkles(headNow);
      else if (fx.kind === "hearts") effects.hearts(character.headTop(), 4);
      else effects.pop(fx.char ?? "✦", overHead, 1.1, 0.4, fx.pink ? PINK : CREAM);
    }, fx.at);
  }
  return true;
}
if (debug) (window as unknown as { charmReact: typeof react }).charmReact = react;

/** The reaction when there is one, otherwise the plain emote. */
function emoteOr(reaction: GestureName | null, e: Emote) {
  if (!reaction || !react(reaction)) character.emote(e);
}

function act(action: ReturnType<typeof respond>["action"], reaction: GestureName | null = null) {
  switch (action.kind) {
    case "dance":
      character.dance();
      break;
    case "nod":
      emoteOr(reaction, "Yes");
      break;
    case "shrug":
      emoteOr(reaction, "No");
      break;
    case "wave":
      emoteOr(reaction, "Wave");
      break;
    case "hop":
      if (!reaction || !react(reaction)) character.hop();
      break;
    case "thumbs":
      emoteOr(reaction, "ThumbsUp");
      break;
    case "timer":
      clock.start(action.seconds, action.label, action.focus);
      emoteOr(reaction, "ThumbsUp");
      break;
    case "timerOp":
      if (action.op === "cancel") clock.cancel();
      else if (action.op === "add") clock.add(action.seconds ?? 60);
      else if (action.op === "pause") clock.pause();
      else clock.resume();
      character.emote("Yes");
      break;
    case "camera":
      showPolaroid(false); // a new photo is coming: questions no longer mean the old one
      dispatch({ type: "request", req: { kind: "camera" } }); // the viewfinder already up: "take a photo" takes it
      break;
    case "sun":
      log("sun card shown");
      sunCard.show();
      emoteOr(reaction, "Wave");
      break;
    case "map":
      if (action.place && action.heard) mapView.guess(action.heard); // the card asks "did you mean?" with the heard words
      dispatch({ type: "request", req: action.place ? { kind: "map", place: action.place } : { kind: "map" } });
      break;
    case "voice":
      voice.set(action.on);
      hud.setMuted(!action.on);
      emoteOr(reaction, action.on ? "Yes" : "No");
      break;
    case "metal":
      if (action.on) {
        dispatch({ type: "request", req: { kind: "metal" } });
        emoteOr(reaction, "Yes");
      }
      else if (fs.req?.kind === "metal") dispatch({ type: "back" }); // "stop" has its own reply
      else log("metal stop: the detector is not on");
      break;
    case "transit": // the map opens (scroll reveal) and ends on the journey (runTrip)
      if (action.dest === "home" && !loadHome()) {
        emoteOr(reaction, "No");
        sayReply(lastHeard, TRIP_LINES.noHome);
        break;
      }
      dispatch({ type: "request", req: { kind: "map", trip: { dest: action.dest, mode: action.mode, heard: action.heard } } });
      break;
    case "departures":
      emoteOr(reaction, "Yes");
      log(`departures ${action.stop ? "named stop" : "nearest stop"} mode=${action.mode}`);
      void mapView.departures(action.stop, action.mode).then(
        (line) => sayReply(lastHeard, line),
        (err) => {
          log(`departures failed: ${err}`);
          sayReply(lastHeard, TRIP_LINES.noTimetable, undefined, true);
        },
      );
      break;
    case "setHome":
      void runSetHome();
      break;
  }
}

// ---- Trams and buses (transit/): GPS is wanted by the map, a trip and "this is my home" independently; the chip
// runs while any of them wants it. Coordinates are never logged. ----
const gpsWants = new Set<string>();
function wantGps(who: string, on: boolean) {
  const before = gpsWants.size > 0;
  if (on) gpsWants.add(who);
  else gpsWants.delete(who);
  const now = gpsWants.size > 0;
  if (now !== before) bridge.send({ type: "gps", on: now });
}
const locator = new Locator();
const lookingForSky = () => hud.show(lastHeard, TRIP_LINES.looking, 4000);

let tripRun = 0;
/** The map is open for a trip: find us (up to 30 s), then plan, show the journey and say it. */
async function runTrip(trip: { dest: string; mode: string; heard?: string }) {
  const mine = ++tripRun;
  const heard = lastHeard;
  const token = fs.token;
  // Still this request: no newer trip, the same map opening, and no other place asked for meanwhile.
  const current = () => mine === tripRun && fs.phase === "open" && fs.token === token && fs.req?.kind === "map" && fs.req.trip === trip;
  wantGps("trip", true);
  const where = await locator.locate(FIX_WAIT_MS, () => {
    lookingForSky();
    mapView.findingYou(trip.dest);
  });
  if (mine === tripRun) wantGps("trip", false); // a newer trip keeps its own want
  if (!current()) return log("trip dropped (newer request or map closed)");
  log(`trip plan dest=${trip.dest === "home" ? "home" : "place"} mode=${trip.mode} fix=${"fix" in where ? (where.old ? "old" : "fresh") : where.error}`);
  try {
    if (trip.heard) mapView.guess(trip.heard); // an unsure place: the card asks "did you mean?"
    const planned = await mapView.transitTo(trip.dest, trip.mode, "fix" in where ? where.fix : undefined);
    if (!current()) return log("trip result dropped (newer request or map closed)");
    const line = trip.heard && planned ? `${guessLine(trip.dest)} ${planned}` : planned;
    log(`trip said (${line.length} chars${trip.heard ? ", a guess" : ""})`);
    sayReply(heard, line || ("error" in where ? locateLine(where) : ""));
  } catch (err) {
    log(`trip failed: ${err}`);
    sayReply(heard, TRIP_LINES.noTimetable, undefined, true);
  }
}

/** "This is my home": a fresh fix (waited for) saved on the phone. */
async function runSetHome() {
  const heard = lastHeard;
  wantGps("home", true);
  const where = await locator.locate(FIX_WAIT_MS, lookingForSky);
  wantGps("home", false);
  if ("error" in where) return sayReply(heard, locateLine(where));
  if (where.old) return sayReply(heard, TRIP_LINES.homeNeedsFix);
  const ok = saveHome(where.fix);
  log(`home saved=${ok}`);
  character.emote(ok ? "Yes" : "No");
  sayReply(heard, ok ? TRIP_LINES.homeSaved : "I couldn't save that, sorry.", undefined, !ok);
}

// The metal detector (metal.ts): the magnetometer streams in while it is on; the meter, Val's eyes and haptics follow.
const metal = createMetal({
  send: (e) => {
    bridge.send(e);
    // The single place the detector reports closed (a voice "stop", the volume key, a switch, or a sensor error).
    if (e.type === "metal" && !e.on) dispatch({ type: "closed", kind: "metal" });
  },
  speak: (text) => sayReply("", text),
  log,
  surprise: (a) => character.mood("Surprised", a),
  lookUp: (on) => character.lookAt(on ? new THREE.Vector3(0, halfHeight + 2, 2) : null), // the phone's top, in screen space
  hop: () => {
    character.hop();
    character.pulseMood("Surprised", 1, 900);
    effects.pop("!", overHead, 1.2, 0.6, PINK);
  },
  meter: createMeter(),
});
bridge.onMag((e) => metal.feed(e));
if (debug) Object.assign(window, { charmMag: (ut: number, delta: number) => bridge.emitMag({ type: "mag", ut, delta }), charmMetal: (on: boolean) => (on ? metal.open() : metal.close(true)) });

// Waiting for the app's command or answer: a friendly line if nothing arrives in time (late answers are dropped).
let answerTimer: number | undefined;
let lastHeard = "";
function awaitAnswer(ms: number) {
  clearTimeout(answerTimer);
  answerTimer = window.setTimeout(() => {
    answerTimer = undefined;
    hud.setEars("off");
    log("answer page timeout");
    character.endGesture("think");
    sayReply(lastHeard, fallbackReply("page timeout"), undefined, true);
  }, ms);
}
function stopWaiting(): boolean {
  const waiting = answerTimer !== undefined;
  clearTimeout(answerTimer);
  answerTimer = undefined;
  return waiting;
}

bridge.onVoice((e) => {
  if (e.type === "level") {
    levels++;
    hud.level(Number(e.v));
    return;
  }
  if (e.type !== "command") log(`voice ${e.type}`);
  switch (e.type) {
    case "listening":
      stopWaiting();
      clearTimeout(lateTimer); // talking over Val: the app cut the voice, the old reply is not typed late
      lateTimer = undefined;
      hud.drop();
      levels = 0;
      listenStart = performance.now();
      hud.setEars("listening");
      character.endGesture("think");
      lendEar(true);
      character.pulseMood("Surprised", 0.3, 800); // perks up to listen
      break;
    case "heard": {
      const secs = (performance.now() - listenStart) / 1000;
      if (listenStart) log(`mic levels ${levels} in ${secs.toFixed(1)} s (${(levels / Math.max(secs, 0.1)).toFixed(1)} Hz)`);
      listenStart = 0;
      lendEar(false);
      lastHeard = String(e.text ?? "").trim();
      hud.setEars(lastHeard ? "thinking" : "off");
      if (lastHeard) awaitAnswer(answerWait({}));
      break;
    }
    case "thinking": // the app is asking the chat model; the ears keep spinning
      if (answerTimer === undefined) { // already gave up on this one
        log("thinking dropped (page gave up)");
        break;
      }
      hud.setEars("thinking");
      react("think"); // hand on chin until the answer comes
      if (e.warming === true) {
        hud.setError(false);
        hud.show(lastHeard, WARMING_LINE, WARMING_TIMEOUT_MS);
      }
      awaitAnswer(answerWait(e));
      log(`thinking warming=${e.warming === true}`);
      break;
    case "answer": {
      if (!stopWaiting()) { // the page already said something for this one
        log("answer dropped (page gave up)");
        break;
      }
      hud.setEars("off");
      const out = answerReply(e);
      log(`answer ok=${out.ok}${out.ok ? "" : ` reason=${String(e.reason)}`} in ${e.ms} ms`);
      character.endGesture("think");
      if (!out.ok) character.emote("No");
      else react(e.source === "facts" ? "proud" : "nod"); // a proud chin-up for a Dresden card, a nod otherwise
      sayReply(String(e.text ?? lastHeard), out.reply, 6000, !out.ok);
      if (out.ok && (e.source === "facts" || e.source === "everyday")) hud.setFact(true); // from Val's cards, not the model
      break;
    }
    case "command": {
      stopWaiting();
      hud.setEars("off");
      const cmd: Command = {
        name: String(e.name ?? "none"),
        args: (e.args as Record<string, unknown>) ?? {},
        confidence: Number(e.confidence ?? 0),
        text: String(e.text ?? ""),
      };
      lastHeard = cmd.text; // the YOU line of whatever act() shows is this command, never an older one
      const out = respond(cmd, notes, new Date(), photoCaption(lastPhoto, performance.now()), clock.snapshot());
      log(`command ${cmd.name} (${cmd.confidence.toFixed(2)}) in ${e.ms} ms`);
      act(out.action, reactionFor(cmd, out));
      if (cmd.name === "fun" && cmd.args.kind === "joke") bridge.send({ type: "haptic", pattern: "giggle" });
      sayReply(cmd.text, out.reply);
      break;
    }
    case "speaking": { // the first sample is playing now
      clearTimeout(lateTimer);
      lateTimer = undefined;
      const ms = Number(e.ms) || 0;
      log(`voice speaking (first audio after ${Math.round(performance.now() - sayAt)} ms, ~${ms} ms long)`);
      hud.setEars("speaking");
      hud.hold(); // the card stays while the words are spoken
      character.talking(true);
      // "spoken" always follows; this only guards against a lost message leaving the card up forever.
      clearTimeout(speakGuard);
      speakGuard = window.setTimeout(() => {
        log("voice spoken missing, card released");
        hud.finish();
        hud.setEars("off");
        hud.release();
        character.talking(false);
      }, ms * 2 + 5000);
      break;
    }
    case "chunk":
      hud.chunk(String(e.text ?? ""), Number(e.ms) || 0);
      break;
    case "word":
      hud.word(Number(e.end) || 0);
      break;
    case "spoken":
      clearTimeout(speakGuard);
      clearTimeout(lateTimer);
      lateTimer = undefined;
      character.talking(false);
      if (hud.ears === "speaking" || hud.ears === "thinking") hud.setEars("off");
      if (e.ok === false && hud.typeNow()) { // no audio at all: the words still reach the user
        log("voice failed, text only");
        break;
      }
      hud.finish();
      hud.release(1500);
      break;
    case "voiceError":
      stopWaiting();
      character.endGesture("think");
      lendEar(false);
      hud.setEars("off");
      hud.setFact(false);
      hud.setError(true);
      hud.show("", e.reason === "waking" ? "Still waking up… try again in a moment." : "My voice is still asleep. Try again soon.", 6000);
      break;
  }
});

// The last photo's caption (the Polaroid text), for "remember this"; the app keeps its own copy for follow-up questions.
let lastPhoto: { caption: string; at: number } | null = null;
let polaroidOn = false;
function showPolaroid(on: boolean) {
  if (on === polaroidOn) return;
  polaroidOn = on;
  bridge.send({ type: "polaroid", on });
}

// ---- Feature overlays (camera, map, metal detector): one at a time, logically (features.ts). Val first pulls the
// feature's prop from behind his back (props/), always upright: the room turns back to the bottom floor and tilt is
// ignored until the feature closes (overlays are portrait). The camera keeps him in the corner bubble; the map hides
// him and pauses drawing; the metal detector keeps him full screen. Opening one while another is up (or revealing)
// closes it fully first, then the new reveal starts. Exactly one place opens (runFeatureEffect "reveal"/"show") and
// one place closes ("close" → the feature's own close callback → "closed" → "end") each feature.
const waitMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const anchor = new THREE.Vector3();
/** Where Val looks while you wait for the photo's answer: down at the print (relative to his head). */
const PEEK_AT = new THREE.Vector3(1.6, -1.4, 2.2);

/** Lock the floor and turn the room back upright (smoothly, alongside the reveal). */
function lockUpright(now = performance.now()) {
  if (picker.locked) return;
  const was = picker.lock();
  const from = fall ? character.root.position.length() : floorDist(was);
  if (was !== "bottom" || fall || room.rotation.z !== 0) righting = { a0: room.rotation.z, d0: from, t0: now };
  fall = null;
  character.root.rotation.z = 0;
  floor = "bottom";
  walkTarget = null;
  carriedX = null;
  body = { x: THREE.MathUtils.clamp(body.x, -floorHalf("bottom"), floorHalf("bottom")), vx: 0, lean: 0 };
}

/** Val pulls out the prop; resolves when the feature may open (at most REVEAL.maxMs, whatever happens). */
function revealProp(kind: PropKind) {
  if (character.mode === "sleeping") bridge.send({ type: "screen", mode: "awake" });
  lockUpright();
  showStage(true);
  log(`reveal ${kind}`);
  const t0 = performance.now();
  return Promise.race([character.reveal(kind), waitMs(REVEAL.maxMs)]).then(() => log(`reveal ${kind} ready in ${Math.round(performance.now() - t0)} ms`));
}

let fs: FeatureState = homeState();
const featureQueue: FeatureEvent[] = [];
let dispatching = false;
/** Val's own touch, knock, wander and shake reactions are off while a feature is revealing, open or closing. */
const inFeature = () => featureBusy(fs);

/** Feed the feature state machine; effects run in order, and events they cause are queued (never re-entered). */
function dispatch(e: FeatureEvent) {
  featureQueue.push(e);
  if (dispatching) return;
  dispatching = true;
  try {
    do {
      while (featureQueue.length) {
        const before = featureLabel(fs);
        const out = featureStep(fs, featureQueue.shift()!);
        fs = out.state;
        const after = featureLabel(fs);
        if (after !== before) log(`feature ${before} → ${after}`);
        for (const fx of out.effects) runFeatureEffect(fx);
        if (fs.phase === "home" || fs.phase === "open") flushSay(); // a transition ended: Val may speak
      }
      reconcileFeatures(); // its teardowns report closes at once: handled (as stale) before anything else
    } while (featureQueue.length);
  } finally {
    dispatching = false;
  }
}

/**
 * The DOM must match the state machine: any overlay that is not the current feature is torn down (a late map open,
 * a camera that outlived its close). Normally a no-op; when it acts, the log says so. The close
 * callbacks it causes report a feature that is not current, so the state machine ignores them as stale.
 */
function reconcileFeatures() {
  for (const kind of mustBeDown(fs)) {
    if (kind === "camera" && photoCam.state !== "closed") {
      log(`feature reconcile: camera still ${photoCam.state} (${featureLabel(fs)}), closing it`);
      photoCam.close();
    } else if (kind === "map" && (mapView.isOpen || mapView.wanted) && !mapView.closing) {
      log(`feature reconcile: map still ${mapView.isOpen ? "open" : "wanted"} (${featureLabel(fs)}), closing it`);
      void mapView.close();
    } else if (kind === "metal" && metal.on) {
      log(`feature reconcile: metal still on (${featureLabel(fs)}), switching it off`);
      metal.close(false);
    }
  }
  if (fs.phase === "home" && !fs.queued && companion.active) {
    log("feature reconcile: bubble still on at home, turning it off");
    companion.exit();
  }
}

function runFeatureEffect(fx: FeatureEffect) {
  switch (fx.do) {
    case "note":
      log(`feature ${fx.text}`);
      break;
    case "reveal":
      startReveal(fx.req, fx.token);
      break;
    case "show":
      showFeature(fx.req, fx.token);
      break;
    case "close":
      closeFeature(fx.kind, fx.spoken);
      break;
    case "end":
      endFeature(fx.kind);
      break;
    case "settle":
      setTimeout(() => dispatch({ type: "settled" }), fx.ms); // Val finishes stowing the old prop first
      break;
    case "shutter":
      cameraAgain();
      break;
    case "goTo":
      log(`map go to (${fx.place.length} chars)`);
      void mapView.open(fx.place);
      break;
    case "trip":
      log(`map trip (${fx.trip.dest === "home" ? "home" : "place"}, ${fx.trip.mode})`);
      void runTrip(fx.trip);
      break;
  }
}

/** The reveal starts, and the slow parts warm up behind it: the camera stream, the map's tiles. */
function startReveal(req: FeatureRequest, token: number) {
  // index.html: the idle [TEXT ONLY] tag hides, and with the map the voice card docks below its top bar.
  document.body.classList.add("overlay");
  document.body.classList.toggle("map-open", req.kind === "map");
  if (req.kind !== "metal") clock.setOverlay(true); // the timer readout moves clear of the camera's and map's corners
  if (req.kind === "camera") {
    cameraToken = token; // the viewfinder's onShow reports this reveal, never a later one
    photoCam.open(revealProp("camera")); // the camera starts now; the viewfinder waits for the reveal and a real frame
  } else if (req.kind === "map") {
    wantGps("map", true); // a fix can arrive while Val unrolls the scroll
    if (!req.place && !req.trip) mapView.reset(); // a plain open never shows the last trip's card or destination
    const loaded = mapView.preload().catch((err) => log(`map preload failed: ${err}`));
    // Still loading when the scroll is unrolled: Val holds it and looks at it; no loading screen.
    void Promise.all([revealProp("scroll"), loaded]).then(() => dispatch({ type: "revealed", token }));
  } else {
    metal.open();
    character.emote("Yes");
    dispatch({ type: "revealed", token });
  }
}

function showFeature(req: FeatureRequest, token: number) {
  if (req.kind === "camera") {
    companion.enter(); // the same frame as the viewfinder's fade-in
  } else if (req.kind === "map") {
    const at = character.propAnchor(anchor) ? toScreen(anchor) : undefined;
    const from = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? at : undefined; // a bad anchor: grow from the centre
    log(`map grows${from ? ` from ${Math.round(from.x)},${Math.round(from.y)}` : ""}`);
    void mapView.open(req.trip ? undefined : req.place, from).then((ok) => {
      if (fs.token !== token || fs.phase !== "open") return; // closed or taken over meanwhile
      if (ok) {
        showStage(false); // Val is not drawn at all behind the map
        if (fs.req?.trip) void runTrip(fs.req.trip); // the latest trip asked while it revealed
        return;
      }
      hud.setFact(false);
      hud.setError(true);
      hud.show("", "My map pages are missing.", 5000);
      dispatch({ type: "back" });
    });
  }
}

function closeFeature(kind: FeatureKind, spoken: boolean) {
  if (kind === "camera") {
    if (photoCam.state === "closed") dispatch({ type: "closed", kind });
    else photoCam.close(); // → onHide → closed
  } else if (kind === "map") {
    // Shown: it shrinks back (onClosing, onClose → closed). Still revealing: it only stops warming up. Either way
    // the close resolves once it is gone (a second "closed" after onClose's is ignored as stale).
    void mapView.close().then(() => dispatch({ type: "closed", kind }));
  } else if (metal.on) metal.close(spoken); // → its "metal off" message → closed
  else dispatch({ type: "closed", kind });
}

/**
 * The feature is gone: Val back to full screen, puts the prop away, and tilt counts again. Runs on every way out
 * (back, a close button, a failed or denied camera, a take-over), whatever was paused: the stow and the arms' return
 * run on the wall clock in the frames that showStage(true) guarantees.
 */
function endFeature(kind: FeatureKind) {
  log(`feature ${kind} ended`);
  document.body.classList.remove("overlay", "map-open", "map-searching", "map-trip");
  if (kind === "map") {
    tripRun++; // a trip still waiting for GPS is dropped
    wantGps("map", false); // the GPS chip runs only while the map (or a trip question) wants it
    wantGps("trip", false);
  }
  clock.setOverlay(false);
  companion.exit(); // back to the full-screen framing (fitCamera)
  showStage(true);
  character.lookAt(null); // a peek at the Polaroid or a lent ear does not outlive the feature
  log(`stow start (${character.mode})`);
  character.stow();
  picker.unlock();
}

/** "Take a photo" while the camera is up: the shutter in the viewfinder, a retake from the Polaroid. */
function cameraAgain() {
  const s = photoCam.state;
  if (s === "preview") photoCam.shutter();
  else if (s === "developing" || s === "done" || s === "error") photoCam.open();
  else log(`camera ${s}: ignored`);
}

// The retro camera: viewfinder, shutter, Polaroid, and "what is this?" from the on-phone vision model.
let cameraToken = 0; // the reveal the camera is opening for
const photoCam = createCamera(document.body, bridge, {
  onShow: () => dispatch({ type: "revealed", token: cameraToken }), // stale or cancelled opens are ignored there
  onHide: () => {
    showPolaroid(false);
    dispatch({ type: "closed", kind: "camera" });
  },
  onShutter: () => {
    if (!character.flash()) log("camera flash: Val is not holding the camera");
  },
  onPeek: (on) => character.lookAt(on ? character.headTop().add(PEEK_AT) : null),
  onAnswer: (text) => {
    lastPhoto = { caption: text, at: performance.now() }; // "remember this" saves it as a note
    showPolaroid(true); // the app may ask the vision model about this same frame again
    character.emote("Yes");
    // Shown on the print too; voice off means no speech. A reply: the app remembers it for "what is it made of?".
    bridge.send(voice.on ? { type: "say", text, reply: true } : { type: "said", text });
  },
  log,
});

// The offline Dresden map: Val unrolls his scroll and the dark map grows out of it, with the GPS dot and walking routes.
const mapView = createMap(document.body, {
  onGrow: () => {
    if (fs.phase === "open" && fs.req?.kind === "map") showStage(false, true); // the canvas keeps its last frame under the map
  },
  onClosing: () => {
    dispatch({ type: "closing", kind: "map" });
    showStage(true); // Val is back, holding the scroll the map shrinks into
  },
  onClose: () => {
    log("map closed");
    dispatch({ type: "closed", kind: "map" });
  },
  onTripLine: (line) => {
    if (fs.phase !== "open" || fs.req?.kind !== "map") return log("late trip line dropped (map closed)");
    log(`trip said after a late fix or the ride chip (${line.length} chars)`);
    sayReply(lastHeard, line);
  },
  log,
});

/** A world point in CSS pixels on the full-screen canvas. */
function toScreen(p: THREE.Vector3) {
  p.project(camera);
  return { x: ((p.x + 1) / 2) * window.innerWidth, y: ((1 - p.y) / 2) * window.innerHeight };
}

/**
 * Show Val and draw, or hide him and stop drawing (while the map covers the screen). keepFrame: stop drawing but
 * leave the canvas showing its last frame (the map is growing over it).
 */
let drawing = false;
function showStage(on: boolean, keepFrame = false) {
  if (!keepFrame) renderer.domElement.style.visibility = on ? "" : "hidden";
  if (!started || on === drawing) return;
  drawing = on;
  if (on) prev = performance.now();
  renderer.setAnimationLoop(on ? frame : null);
  log(on ? "drawing resumed" : "drawing paused (map open)");
}
let skyLogs = 0;
bridge.onFix((f) => {
  if (f.type === "sky") { // once a second while GPS is on: log one in ten
    if (skyLogs++ % 10 === 0) log(`gps sky total=${Number(f.total)} used=${Number(f.used)}`);
    mapView.setSky(Number(f.total), Number(f.used), Number(f.best));
    return;
  }
  const ageMs = f.ageMs === undefined ? undefined : Number(f.ageMs);
  if (f.type === "fix") log(`gps fix acc=${Math.round(Number(f.acc))} m age=${Math.round((ageMs ?? 0) / 1000)} s`);
  if (f.type === "fix") locator.feed(Number(f.lat), Number(f.lon), Number(f.acc), ageMs);
  else if (f.type === "fixError" && (f.reason === "gpsOff" || f.reason === "denied")) locator.fail();
  if (f.type === "fix") mapView.setFix(Number(f.lat), Number(f.lon), Number(f.acc), f.heading === undefined ? undefined : Number(f.heading), ageMs);
  else {
    log(`gps: ${String(f.reason)}`);
    if (f.reason === "gpsOff" || f.reason === "denied") mapView.setGpsOff(); // both need the user to allow location
  }
});

// Volume-down presses: 1 closes what is open, 2 opens the camera (or takes the photo), 3 the map, 4 the metal detector.
bridge.onButton((b) => {
  if (b === "talkStart" || b === "talkEnd") return;
  log(`button ${b}`);
  bridge.send({ type: "haptic", pattern: "tick" });
  if (b === "back") dispatch({ type: "back", spoken: true });
  else if (b === "look") {
    showPolaroid(false); // a new photo is coming: questions no longer mean the old one
    dispatch({ type: "request", req: { kind: "camera" } }); // opens it, or takes the photo if it is up
  } else if (b === "map") dispatch({ type: "request", req: { kind: "map" } });
  else if (b === "metal") dispatch({ type: "request", req: { kind: "metal" } });
});

function onGesture(g: Gesture) {
  log(`gesture ${g}`);
  bridge.send({ type: "gesture", name: g });
  if (inFeature() && g !== "faceUp" && g !== "faceDown") return log(`gesture ${g} ignored (${featureLabel(fs)})`);
  switch (g) {
    case "shake":
      character.tumble();
      effects.stars(headNow);
      bridge.send({ type: "haptic", pattern: "tumble" });
      break;
    case "wiggle":
      character.hop();
      effects.pop("◉", overHead);
      bridge.send({ type: "haptic", pattern: "tick" });
      break;
    case "faceDown":
      if (character.sleep()) bridge.send({ type: "screen", mode: "sleep" });
      break;
    case "faceUp":
      character.wake();
      bridge.send({ type: "screen", mode: "awake" }); // always safe: restores normal brightness
      break;
    case "pickup":
      character.emote("Wave");
      break;
    case "spin":
      character.spin();
      bridge.send({ type: "haptic", pattern: "giggle" });
      break;
  }
}

// Knock on the table: the app finds the knocks (Knock.kt); each one rings the seismograph and the first turns Val's
// head towards it; the finished group decides the rest (knock.ts): 1 = a surprised hop, 2 = "who's there?" (or wake
// up), 3 = a little dance. No haptics here: the buzz would shake the table it is listening to.
const seismo = createSeismograph();
let glanceTimer: number | undefined;
const POP_SPOT = new THREE.Vector3(0.55, 0.85, 0.5); // up and aside: headTop() sits inside the big head
const aboveHead = () => character.headTop(_headNow).add(POP_SPOT);
function glance(side: KnockSide | null) {
  const dir = glanceDir(side);
  if (!dir || pressStart || character.mode !== "normal") return; // a finger steering the head wins
  character.lookAt(character.headTop().add(new THREE.Vector3(dir[0] * 3, dir[1] * 3, 1.5)));
  clearTimeout(glanceTimer);
  glanceTimer = window.setTimeout(() => {
    if (!pressStart) character.lookAt(null);
  }, 1500);
}
bridge.onKnock((e) => {
  if (e.type === "knock") {
    log(`knock n=${e.n} side=${e.side ?? "none"} peak=${e.peak.toFixed(1)}`);
    seismo.knock(Math.min(e.peak / 8, 1));
    if (e.n === 1 && !inFeature()) glance(e.side); // the seismograph still rings; Val stays on his feature
    return;
  }
  if (inFeature()) return log(`knocks n=${e.n} ignored (${featureLabel(fs)})`);
  const reaction = knockReaction(e.n, character.mode);
  log(`knocks n=${e.n} -> ${reaction}`);
  switch (reaction) {
    case "hop":
      character.hop();
      character.pulseMood("Surprised", 0.8, 700);
      break;
    case "wake":
      character.wake();
      bridge.send({ type: "screen", mode: "awake" });
      effects.pop("?!", aboveHead, 1.4, 0.4, PINK);
      break;
    case "whosThere":
      glance(e.side);
      character.emote("Wave");
      character.pulseMood("Surprised", 0.6, 900);
      effects.pop("?!", aboveHead, 1.4, 0.4, PINK);
      break;
    case "dance":
      character.dance();
      effects.hearts(character.headTop(), 3);
      break;
  }
});

// Touch: tap, double tap, three quick pokes, drag to carry.
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let taps: number[] = [];
let pressStart: { x: number; y: number; t: number } | null = null;
let pressOnCharacter = false;
let singleTapTimer: number | undefined;

function hitsCharacter(clientX: number, clientY: number) {
  pointer.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObject(character.root, true).length > 0;
}

/** Where a finger is, in world space on the screen plane. */
function screenToWorld(clientX: number, clientY: number) {
  pointer.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = new THREE.Vector3();
  raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), hit);
  return hit;
}

/** A finger position as a spot along the current floor. */
function screenToFloorX(clientX: number, clientY: number) {
  const local = room.worldToLocal(screenToWorld(clientX, clientY));
  return THREE.MathUtils.clamp(local.x, -floorHalf(floor), floorHalf(floor));
}


/** End a drag in every case (release, Android swipe-cancel, or a gesture that took over). */
function endPress(cancelled: boolean) {
  clearTimeout(carryHold);
  carryArmed = false;
  character.lookAt(null);
  const wasCarried = character.mode === "carried";
  pressStart = null;
  if (carriedX !== null || wasCarried) {
    carriedX = null;
    character.setCarried(false);
    if (wasCarried) {
      bridge.send({ type: "haptic", pattern: "bump" });
      log("dropped");
    }
    return true;
  }
  return cancelled;
}

let carryArmed = false;
let carryHold: number | undefined;

renderer.domElement.addEventListener("pointerdown", (e) => {
  // While a feature is revealing, open or closing, the screen belongs to it: no carry, taps or pokes.
  // Talking is the volume key only: a touch never starts the microphone.
  if (inFeature()) return log(`touch ignored (${featureLabel(fs)})`);
  character.lookAt(screenToWorld(e.clientX, e.clientY)); // the head follows your finger
  pressStart = { x: e.clientX, y: e.clientY, t: performance.now() };
  pressOnCharacter = hitsCharacter(e.clientX, e.clientY);
  // Carrying needs a deliberate long-press on the robot first, so a moving finger never drags it around.
  carryArmed = false;
  if (pressOnCharacter) {
    carryHold = window.setTimeout(() => {
      carryArmed = true;
      bridge.send({ type: "haptic", pattern: "tick" });
    }, 450);
  }
});

renderer.domElement.addEventListener("pointermove", (e) => {
  if (!pressStart) return;
  const moved = Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 24;
  if (moved && !carryArmed) clearTimeout(carryHold); // moved before the long-press: not a carry
  character.lookAt(screenToWorld(e.clientX, e.clientY));
  if (!pressOnCharacter || !carryArmed) return;
  if (carriedX === null && moved) {
    character.setCarried(true);
    if (character.mode === "carried") {
      carriedX = screenToFloorX(e.clientX, e.clientY);
      log("carried");
    }
  }
  if (character.mode === "carried") carriedX = screenToFloorX(e.clientX, e.clientY);
});

renderer.domElement.addEventListener("pointercancel", () => endPress(true));
for (const type of ["pointerdown", "pointermove", "pointerup"]) renderer.domElement.addEventListener(type, () => (lastTouchAt = performance.now()), { passive: true });

renderer.domElement.addEventListener("pointerup", (e) => {
  if (!pressStart) return;
  if (endPress(false)) return;
  if (inFeature()) return; // pressed before a feature started: no tap reaction now
  const now = performance.now();
  if (!pressOnCharacter) {
    // Tapping empty space: it looks there and walks over (so people learn that touch works).
    walkTarget = screenToFloorX(e.clientX, e.clientY);
    log("walk to tap");
    return;
  }
  taps = [...taps.filter((t) => now - t < 1500), now];
  if (taps.length >= 3) {
    taps = [];
    clearTimeout(singleTapTimer);
    character.pulseMood("Angry", 1, 1500);
    character.emote("No");
    bridge.send({ type: "haptic", pattern: "bump" });
    log("poked: grumpy");
  } else if (taps.length === 2 && now - taps[0] < 350) {
    clearTimeout(singleTapTimer);
    character.dance();
    bridge.send({ type: "haptic", pattern: "giggle" });
    log("double tap: dance");
  } else {
    clearTimeout(singleTapTimer);
    singleTapTimer = window.setTimeout(() => {
      character.hop();
      character.pulseMood("Surprised", 0.3, 500);
      effects.hearts(character.headTop());
      bridge.send({ type: "haptic", pattern: "giggle" });
      log("tap: giggle");
    }, 360);
  }
});

// Test mode: replay a synthetic trace (`?replay=shake`), callable again from the app via window.charmReplay.
function replay(name: string) {
  const make = TRACES[name];
  if (!make) return log(`unknown trace ${name}`);
  const samples = make();
  const t0 = performance.now();
  bridge.muteLiveFor(samples[samples.length - 1].t + 300);
  log(`replay ${name}`);
  samples.forEach((s) => setTimeout(() => bridge.emit({ ...s, t: t0 + s.t }), s.t));
}
// Test hooks: only in debug mode (`?debug=1`), never in normal use.
if (debug) (window as unknown as { charmReplay: typeof replay }).charmReplay = replay;
// Main-thread stalls over 50 ms (feature opens and closes must have none), for the phone's log.
if (debug) {
  try {
    new PerformanceObserver((list) => {
      for (const t of list.getEntries()) log(`longtask ${Math.round(t.duration)} ms (${featureLabel(fs)})`);
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    log("longtask observer unavailable");
  }
}
// Feeds voice events as if the app sent them (the page alone cannot hand itself the app's port).
if (debug) (window as unknown as { charmVoice: (e: VoiceEvent) => void }).charmVoice = (e) => bridge.emitVoice(e);
if (debug) (window as unknown as { charmFix: (lat: number, lon: number, acc?: number) => void }).charmFix = (lat, lon, acc = 10) => bridge.emitFix({ type: "fix", lat, lon, acc });
// A vision answer as if the app sent it, e.g. charmVision({ type: "vision", id: 1, text: "It looks like a mug", ms: 9000 }).
if (debug) (window as unknown as { charmVision: (e: VisionEvent) => void }).charmVision = (e) => bridge.emitVision(e);
// Knocks as if the app found them: charmKnock(n, side) sends n knocks 250 ms apart, then the group.
if (debug) (window as unknown as { charmKnock: (n?: number, side?: string) => void }).charmKnock = (n = 1, side) => {
  for (let i = 0; i < n; i++) setTimeout(() => bridge.emitKnock({ type: "knock", n: i + 1, side, peak: 3 + 2 * i }), i * 250);
  setTimeout(() => bridge.emitKnock({ type: "knocks", n, side }), (n - 1) * 250 + 600);
};
// The corner bubble on its own, without a feature overlay (to check its framing and frame rate).
if (debug) (window as unknown as { charmCompanion: typeof companion }).charmCompanion = companion;
if (debug) (window as unknown as { charmState: () => object }).charmState = () => ({
  floor,
  mode: character.mode,
  animation: character.animation,
  x: Number(body.x.toFixed(2)),
  lean: Number(body.lean.toFixed(2)),
  feature: featureLabel(fs),
  floorLocked: picker.locked,
  drawing,
});
// The edge timer without voice: charmTimer(90) or charmTimer(480, "pasta"); charmTimer(0) cancels.
if (debug) (window as unknown as { charmTimer: (s: number, label?: string) => void }).charmTimer = (s, label) => (s > 0 ? clock.start(s, label) : clock.cancel());
// Acts out a command as if Needle had picked it, e.g. charmAct({ kind: "camera", describe: true }) or { kind: "map" }.
if (debug) (window as unknown as { charmAct: typeof act }).charmAct = act;
// A volume-key shortcut without the phone: charmButton("back"), charmButton("look"), charmButton("map").
if (debug) (window as unknown as { charmButton: (b: ButtonName) => void }).charmButton = (b) => bridge.emitButton(b);
// The character itself (to pose and time the prop reveal without opening a feature).
if (debug) (window as unknown as { charmCharacter: Character }).charmCharacter = character;
// Orbits the camera round Val to check the model from the side: charmView("34"), charmView("side", true) for a
// close-up of the head, charmView() back to normal.
const DEBUG_YAW = { front: 0, "34": Math.PI / 4, side: Math.PI / 2, back: Math.PI } as const;
let debugView: { yaw: number; close: boolean } | null = null;
function aimDebugView(v: { yaw: number; close: boolean }) {
  // The middle of the head, or of the whole robot (on the bottom floor, world up is the robot's up).
  const target = v.close ? character.headTop() : character.root.getWorldPosition(new THREE.Vector3());
  target.y += v.close ? -0.45 : 1.3;
  const dist = v.close ? 6.5 : 13;
  camera.position.set(target.x + Math.sin(v.yaw) * dist, target.y, target.z + Math.cos(v.yaw) * dist);
  camera.lookAt(target);
}
if (debug) (window as unknown as { charmView: (view?: keyof typeof DEBUG_YAW, close?: boolean) => void }).charmView = (view, close = false) => {
  debugView = view ? { yaw: DEBUG_YAW[view], close } : null;
  if (!view) fitCamera();
};
// Forces a floor (to test the portrait lock from a sideways or upside-down room without a phone).
if (debug) (window as unknown as { charmFloor: (f: Floor) => void }).charmFloor = (f) => {
  if (!picker.locked && f !== floor) startFall(f);
};

// Desktop development fallback: the browser's own motion events, when there is no app bridge.
window.addEventListener("devicemotion", (e) => {
  if (bridge.native || !e.accelerationIncludingGravity || !e.acceleration) return;
  const gi = e.accelerationIncludingGravity;
  const a = e.acceleration;
  const r = e.rotationRate;
  const deg = Math.PI / 180;
  bridge.emitBrowser({
    t: performance.now(),
    gravity: [(gi.x ?? 0) - (a.x ?? 0), (gi.y ?? 0) - (a.y ?? 0), (gi.z ?? 0) - (a.z ?? 0)],
    linear: [a.x ?? 0, a.y ?? 0, a.z ?? 0],
    gyro: [(r?.beta ?? 0) * deg, (r?.gamma ?? 0) * deg, (r?.alpha ?? 0) * deg],
  });
});

/** Begin falling from the current floor onto `next`, keeping the character's screen position as the start. */
function startFall(next: Floor) {
  if (!character.startFall()) return;
  const from = character.root.getWorldPosition(new THREE.Vector3());
  const a0 = FLOOR_ANGLE[floor];
  let a1 = FLOOR_ANGLE[next];
  while (a1 - a0 > Math.PI) a1 -= Math.PI * 2; // turn the short way
  while (a1 - a0 < -Math.PI) a1 += Math.PI * 2;
  // Land where a straight drop would: keep the coordinate along the new floor.
  const probe = new THREE.Group();
  probe.rotation.z = FLOOR_ANGLE[next];
  probe.updateMatrixWorld(true);
  const local = probe.worldToLocal(from.clone());
  const x1 = THREE.MathUtils.clamp(local.x, -floorHalf(next), floorHalf(next));
  const to = probe.localToWorld(new THREE.Vector3(x1, -floorDist(next), 0));
  floor = next;
  walkTarget = null;
  fall = { from, to, a0, a1, t: 0, x1 };
  bridge.send({ type: "haptic", pattern: "tumble" });
  log(`falling to ${next}`);
}

/** Light, proximity and battery from the app: sunglasses in the sun, a lantern in the dark, peekaboo when covered. */
function wireSensors() {
  const glasses = character.seatOnEyes(createSunglasses);
  const lantern = createLantern();
  lantern.position.set(0.7, 0.9, 0.3);
  character.root.add(lantern);
  const reactions = createReactions(
    {
      mood: (m, a) => character.mood(m, a),
      emote: (n) => character.emote(n),
      hop: () => character.hop(),
      tuckHead: (a) => character.tuckHead(a),
      setPace: (k) => character.setPace(k),
      free: () => character.mode === "normal",
    },
    {
      pop: (glyph, color) => effects.pop(glyph, overHead, 1.2, 0.6, color),
      haptic: (p) => bridge.send({ type: "haptic", pattern: p }),
      sunglasses: (on) => {
        if (glasses) glasses.visible = on;
      },
      lantern: (on) => (lantern.visible = on),
    },
  );
  sensorSink = (e) => reactions.handle(e);
  for (const e of latestSensor.values()) reactions.handle(e);
}

// Render loop with idle wandering and an fps meter.
let started = false; // the model has loaded and the render loop may run
let prev = performance.now();
let frames = 0;
let fpsWindowStart = prev;
let lastFpsReport = prev;

async function start() {
  await character.load("RobotExpressive.glb", room);
  wireSensors();
  say("");
  log("ready");
  const trace = params.get("replay");
  if (trace) setTimeout(() => replay(trace), 1500);
  started = true;
  showStage(!(fs.phase === "open" && fs.req?.kind === "map")); // starts the render loop
  clock.restore(); // a timer from before a reload resumes (or rings now, if it ran out meanwhile)
  warmUpInIdle();
  setTimeout(prewarmMap, MAP_PREWARM_MS);
}

/** Run fn in idle time (within timeoutMs at the latest), or soon where the browser has no idle callbacks. */
function idle(fn: () => void, timeoutMs: number) {
  if ("requestIdleCallback" in window) window.requestIdleCallback(() => fn(), { timeout: timeoutMs });
  else setTimeout(fn, 50);
}

/**
 * After the first frames, one step per idle callback (props, then effects, then textures), so no single start-up
 * task compiles everything at once (a 0.5 s stall on the phone). Each step is short and self-contained.
 */
function warmUpInIdle() {
  const steps: [string, () => void][] = [
    ["prop shaders", () => character.warmUp(renderer, scene, camera)],
    ["effect shaders", () => effects.warmUp(renderer, scene, camera)],
    ["textures", () => (character.warmTextures(renderer), effects.warmTextures(renderer))],
    ["shutter sound", () => photoCam.warm()],
  ];
  const next = () => {
    const step = steps.shift();
    if (!step) return;
    idle(() => {
      const t0 = performance.now();
      step[1]();
      log(`warm-up ${step[0]} in ${Math.round(performance.now() - t0)} ms`);
      next();
    }, 3000);
  };
  next();
}

/**
 * Make the map once, in idle time well after Val has loaded, so the first "where am I" only has to fade it in. It
 * waits for a calm moment (no touch for MAP_CALM_TOUCH_MS, Val in his normal mode, no feature) and never forces
 * itself in with an idle timeout. An earlier map open warms the map itself (prewarm is then a no-op).
 */
const MAP_PREWARM_MS = DEVICE.mapPrewarmMs;
const MAP_CALM_TOUCH_MS = 2000;
const MAP_RECHECK_MS = 1000;
function prewarmMap() {
  const calm = () => !inFeature() && character.mode === "normal" && !pressStart && performance.now() - lastTouchAt > MAP_CALM_TOUCH_MS;
  if (!calm()) return void setTimeout(prewarmMap, MAP_RECHECK_MS);
  if (!("requestIdleCallback" in window)) return void mapView.prewarm();
  window.requestIdleCallback(() => (calm() ? void mapView.prewarm() : void setTimeout(prewarmMap, MAP_RECHECK_MS)));
}

/** Val's entrance on the first frame: he drops onto the floor (ease-in) and lands with a squash, 300 ms in all. */
const ENTRANCE = { ms: 300, dropShare: 0.6, height: 1.2, squash: 0.22 };
let entranceAt = 0; // the first drawn frame's time
let entranceLanded = false;

/** Is the full-screen loop at 30 fps because Val stands still (or the voice models are busy)? */
let idleCapped = false;
/** Gravity at the last drawn frame: a bigger change than IDLE_GRAVITY_DELTA ends the idle cap at once. */
const drawnGravity: [number, number, number] = [0, 9.81, 0];

function frame(now: number) {
  // If motion data stops (sensor paused), ease back to "upright" instead of freezing tilted.
  if (now - lastSampleAt > 500) gravity = [gravity[0] * 0.9, gravity[1] + (9.81 - gravity[1]) * 0.1, gravity[2] * 0.9];
  const along = alongFloor(floor, gravity);
  // Asleep, nothing moves much: ~20 fps. In the corner bubble behind a feature, standing still, or while the voice
  // listens and thinks: 30 fps. Saves battery, heat and the fast cores the models need.
  const capped = idleCap({
    calm: character.mode === "normal" && !inFeature() && walkTarget === null,
    turning: fall !== null || righting !== null || !entranceLanded,
    vx: body.vx,
    along,
    particles: effects.count,
    touchAgoMs: pressStart ? 0 : now - lastTouchAt,
    gravityDelta: Math.max(Math.abs(gravity[0] - drawnGravity[0]), Math.abs(gravity[1] - drawnGravity[1]), Math.abs(gravity[2] - drawnGravity[2])),
    voiceBusy: hud.ears === "listening" || hud.ears === "thinking",
  });
  if (capped !== idleCapped) {
    idleCapped = capped;
    if (debug) log(`fps cap idle ${capped ? "on" : "off"}`);
  }
  if (now - prev < frameGap(companion.active, character.mode === "sleeping", capped)) return;
  const dt = Math.min((now - prev) / 1000, 0.1);
  prev = now;
  drawnGravity[0] = gravity[0];
  drawnGravity[1] = gravity[1];
  drawnGravity[2] = gravity[2];
  const half = floorHalf(floor);

  // A big tilt makes another edge the floor: the character falls across the screen onto it.
  if (!fall && (character.mode === "normal" || character.mode === "dancing" || character.mode === "tumbling")) {
    const pressed = Math.abs(body.x) > floorHalf(floor) * 0.92 ? cornerFloor(floor, body.x > 0 ? 1 : -1) : null;
    const next = picker.update(gravity, now, pressed);
    if (next && next !== floor) startFall(next);
  } else {
    picker.reset(); // a hold only counts while the character can actually fall
  }

  // While the phone is held sideways, show the hold: it clings to the edge, and ticks speed up towards the fall.
  const clinging = fall ? 0 : picker.progress(now);
  character.cling(clinging);
  if (clinging > 0) {
    if (clinging > 0.15) character.mood("Surprised", 0.3 + 0.6 * clinging);
    if (now > nextClingTick) {
      bridge.send({ type: "haptic", pattern: "tick" });
      nextClingTick = now + 900 - 700 * clinging;
    }
  }

  // Asleep: little z's drift up.
  if (character.mode === "sleeping" && now > nextZzz && !companion.active) {
    effects.pop("z", overHead, 2.2, 0.9);
    nextZzz = now + 1800;
  }

  // Idle wandering when the phone is level and nothing else is going on (not in the bubble: it would walk out of frame).
  if (companion.active || inFeature()) walkTarget = null; // no wandering while a feature is up
  else if (character.mode === "normal" && !character.currentGesture && !clock.focus && Math.abs(along) < 1 && now > nextWanderAt) {
    const pick = Math.random();
    if (pick < 0.5) walkTarget = (Math.random() * 2 - 1) * half * 0.8;
    else if (pick < 0.7) character.emote("Wave");
    else if (pick < 0.85) character.emote("ThumbsUp");
    else character.emote("Yes");
    nextWanderAt = now + 7000 + Math.random() * 7000;
  }
  if (walkTarget !== null && Math.abs(walkTarget - body.x) < 0.06) walkTarget = null;
  if (Math.abs(along) >= 1) walkTarget = null;

  if (fall) {
    fall.t = Math.min(1, fall.t + dt / 0.85);
    const k = fall.t < 0.5 ? 2 * fall.t * fall.t : 1 - Math.pow(-2 * fall.t + 2, 2) / 2; // ease in and out: smooth round the corner
    const world = _fallAt.copy(fall.from).lerp(fall.to, k);
    room.rotation.z = fall.a0 + (fall.a1 - fall.a0) * fall.t;
    const local = room.worldToLocal(world);
    character.root.position.set(local.x, local.y, 0);
    character.root.rotation.z = Math.sin(fall.t * Math.PI) * 0.45; // a small tumble on the way, not a wild flail
    if (fall.t >= 1) {
      room.rotation.z = fall.a1;
      body = { x: fall.x1, vx: 0, lean: 0 };
      character.root.position.set(body.x, -floorDist(floor), 0);
      character.root.rotation.z = 0;
      fall = null;
      character.land();
      effects.stars(headNow, 1.2);
      bridge.send({ type: "haptic", pattern: "bump" });
      log(`landed on ${floor}`);
    }
  } else if (carriedX !== null && character.mode === "carried") {
    const x = body.x + (carriedX - body.x) * Math.min(dt * 12, 1);
    body = { x, vx: 0, lean: body.lean * 0.9 }; // carried steadily: no swinging
  } else if (character.mode === "normal" || character.mode === "dancing") {
    const r = step(body, character.mode === "dancing" ? 0 : along, dt, walkTarget, half);
    body = r.state;
    if (r.bumped) {
      character.kick(0.18);
      character.mood("Surprised", 0.8);
      setTimeout(() => character.mood("Surprised", 0), 500);
      bridge.send({ type: "haptic", pattern: "bump" });
      log("bump");
    }
  }
  if (carriedX !== null && character.mode !== "carried") carriedX = null; // a gesture interrupted the carry

  // Debug: log the live tilt reading twice a second, to check directions against real hands.
  if (debug && now - lastGravityLog > 500) {
    lastGravityLog = now;
    console.log(`charm:${gravityText} floor=${floor} along=${along.toFixed(1)} x=${body.x.toFixed(2)}`);
  }
  if (righting) {
    const k = Math.min(1, (now - righting.t0) / REVEAL.rightMs);
    room.rotation.z = rightingAngle(righting.a0, FLOOR_ANGLE.bottom, k);
    character.root.position.y = -(righting.d0 + (floorDist("bottom") - righting.d0) * easeOut(k));
    if (k >= 1) righting = null;
  } else if (!fall) {
    room.rotation.z = FLOOR_ANGLE[floor];
    character.root.position.y = -floorDist(floor);
  }
  if (!entranceLanded) {
    entranceAt ||= now;
    const k = (now - entranceAt) / (ENTRANCE.ms * ENTRANCE.dropShare);
    if (k < 1) character.root.position.y += ENTRANCE.height * (1 - k * k);
    else {
      entranceLanded = true;
      character.kick(ENTRANCE.squash); // the squash spring settles in the remaining ~120 ms
    }
  }

  effects.update(dt);
  seismo.update(now);

  character.update(dt, now, body, character.mode === "carried" ? 0.35 : 0);
  if (companion.active) companion.aim();
  else if (debugView) aimDebugView(debugView);
  renderer.render(scene, camera);

  frames++;
  if (now - fpsWindowStart >= 1000) {
    const fps = Math.round((frames * 1000) / (now - fpsWindowStart));
    frames = 0;
    fpsWindowStart = now;
    if (debug) document.getElementById("fps")!.textContent = `${fps} fps · ${floor} · ${gravityText}`;
    if (now - lastFpsReport > 5000) {
      lastFpsReport = now;
      bridge.send({ type: "fps", value: fps });
      console.log(`charm:fps ${fps}`);
    }
  }
}

start().catch((err) => {
  say("Val couldn't wake up. Please restart the app.");
  log(`load failed: ${err}`);
});
