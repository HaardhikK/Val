// Talks to the Android app: motion samples come in, haptics and gesture events go out.
// Inside the app the channel is a WebMessagePort sent by MainActivity; in a desktop browser
// (development) it falls back to the page's own devicemotion events, or to nothing.
import type { MotionSample } from "./gestures";
import { parseKnock, type KnockEvent } from "./knock";

export type NativeEvent =
  | { type: "haptic"; pattern: "tick" | "bump" | "tumble" | "giggle" | "shutter" }
  | { type: "gesture"; name: string }
  | { type: "screen"; mode: "sleep" | "awake" }
  | { type: "fps"; value: number }
  /** `reply`: Val answers what the user just said (the app remembers it for follow-ups); false for spontaneous lines. */
  | { type: "say"; text: string; reply: boolean }
  /** A reply shown as text only (voice off), for the app's conversation memory. */
  | { type: "said"; text: string }
  | { type: "gps"; on: boolean }
  | { type: "metal"; on: boolean }
  | { type: "describe"; id: number; image: string; prompt: string }
  | { type: "polaroid"; on: boolean };

type SampleListener = (s: MotionSample) => void;
export type ButtonName = "back" | "look" | "map" | "metal" | "talkStart" | "talkEnd";
type ButtonListener = (b: ButtonName) => void;
/**
 * Voice events from the app: listening, level (mic 0..1, ~15 Hz), heard, command, speaking { ms } when the first audio
 * sample plays, chunk { i, text, ms } as each spoken chunk starts, spoken { ok } after the last sample, voiceError, and for
 * questions thinking { warming, ms } then answer { ok, reply | reason, text, ms }. The app routes and asks the chat model
 * itself (one hop fewer than the page asking), so the page only shows and speaks the answer.
 */
export type VoiceEvent = { type: string; [key: string]: unknown };
type VoiceListener = (e: VoiceEvent) => void;
const VOICE_TYPES = new Set(["listening", "level", "heard", "command", "thinking", "answer", "speaking", "chunk", "word", "spoken", "voiceError"]);
/** Proximity, light and battery readings from the app (Extras.kt), sent only when they change. */
export type SensorEvent =
  | { type: "proximity"; near: boolean }
  | { type: "light"; level: "dark" | "normal" | "bright"; lux: number }
  | { type: "battery"; level: number; charging: boolean; temp: number };
type SensorListener = (e: SensorEvent) => void;

/** Validates a sensor message from the app; anything malformed is dropped. */
export function parseSensor(msg: Record<string, unknown>): SensorEvent | null {
  if (msg.type === "proximity" && typeof msg.near === "boolean") return { type: "proximity", near: msg.near };
  if (msg.type === "light" && (msg.level === "dark" || msg.level === "normal" || msg.level === "bright")) {
    return { type: "light", level: msg.level, lux: Number(msg.lux) || 0 };
  }
  if (msg.type === "battery" && typeof msg.level === "number" && typeof msg.charging === "boolean") {
    return { type: "battery", level: msg.level, charging: msg.charging, temp: Number(msg.temp) || 0 };
  }
  return null;
}

/** Vision answers from the app: { type: "vision", id, text, ms } or { type: "visionError", id, reason }. */
export type VisionEvent = { type: "vision" | "visionError"; [key: string]: unknown };
type VisionListener = (e: VisionEvent) => void;
/** GPS from the app: a fix, an error, or the satellites it hears (`sky` { total, used, best }, 1 Hz while GPS is on). */
export type FixEvent = { type: "fix" | "fixError" | "sky"; [key: string]: unknown };
type FixListener = (e: FixEvent) => void;
type KnockListener = (e: KnockEvent) => void;

/** Magnetometer readings while the metal detector is on (Metal.kt): field and distance from the baseline, in µT. */
export type MagEvent = { type: "mag"; ut: number; delta: number } | { type: "magError"; reason: string };
type MagListener = (e: MagEvent) => void;

/** Validates a magnetometer message from the app; anything malformed is dropped. */
export function parseMag(msg: Record<string, unknown>): MagEvent | null {
  if (msg.type === "mag" && Number.isFinite(msg.ut) && Number.isFinite(msg.delta)) {
    return { type: "mag", ut: Number(msg.ut), delta: Math.max(0, Number(msg.delta)) };
  }
  if (msg.type === "magError") return { type: "magError", reason: String(msg.reason ?? "") };
  return null;
}

export class Bridge {
  private port: MessagePort | null = null;
  private listeners: SampleListener[] = [];
  private buttonListeners: ButtonListener[] = [];
  private voiceListeners: VoiceListener[] = [];
  private sensorListeners: SensorListener[] = [];
  private visionListeners: VisionListener[] = [];
  private fixListeners: FixListener[] = [];
  private magListeners: MagListener[] = [];
  private knockListeners: KnockListener[] = [];
  /** While a test replay runs, live sensor samples are dropped: they use another clock and would interleave. */
  private replayUntil = 0;

  constructor() {
    window.addEventListener("message", (e: MessageEvent) => {
      // Only the app may hand over the port: its messages have no source window (WebView 94 also leaves origin empty).
      const fromApp = e.source === null && (e.origin === location.origin || e.origin === "");
      if (e.data === "charm-port" && e.ports[0] && fromApp) {
        this.port?.close(); // the app opens a fresh channel after each page load
        this.port = e.ports[0];
        this.port.onmessage = (m) => this.onNative(m.data);
      }
    });
  }

  onVoice(l: VoiceListener) {
    this.voiceListeners.push(l);
  }

  /** Feed a voice event to the listeners as if the app sent it (the debug hook window.charmVoice). */
  emitVoice(e: VoiceEvent) {
    if (typeof e?.type === "string" && VOICE_TYPES.has(e.type)) for (const l of this.voiceListeners) l(e);
  }

  onSensor(l: SensorListener) {
    this.sensorListeners.push(l);
  }

  /** GPS fixes from the app: { type: "fix", lat, lon, acc, ageMs, heading? } or { type: "fixError", reason }. */
  onFix(l: FixListener) {
    this.fixListeners.push(l);
  }

  /** Feed a GPS message as if the app sent it (the debug hook window.charmFix). */
  emitFix(e: FixEvent) {
    for (const l of this.fixListeners) l(e);
  }

  onMag(l: MagListener) {
    this.magListeners.push(l);
  }

  /** Feed a magnetometer reading as if the app sent it (the debug hook window.charmMag). */
  emitMag(e: MagEvent) {
    for (const l of this.magListeners) l(e);
  }

  /** Knocks on the table under the phone, found by the app (Knock.kt). */
  onKnock(l: KnockListener) {
    this.knockListeners.push(l);
  }

  /** Feed a knock event as if the app sent it (the debug hook window.charmKnock). */
  emitKnock(raw: Record<string, unknown>) {
    const e = parseKnock(raw);
    if (e) for (const l of this.knockListeners) l(e);
  }

  onVision(l: VisionListener) {
    this.visionListeners.push(l);
  }

  /** Feed a vision answer as if the app sent it (the debug hook window.charmVision). */
  emitVision(e: VisionEvent) {
    for (const l of this.visionListeners) l(e);
  }

  onButton(l: ButtonListener) {
    this.buttonListeners.push(l);
  }

  /** Feed a volume-key shortcut as if the app sent it (the debug hook window.charmButton). */
  emitButton(name: ButtonName) {
    for (const l of this.buttonListeners) l(name);
  }

  onSample(l: SampleListener) {
    this.listeners.push(l);
  }

  /** Used by test mode and the desktop fallback. */
  emit(s: MotionSample) {
    for (const l of this.listeners) l(s);
  }

  /** Mute live samples for the length of a replay. */
  muteLiveFor(ms: number) {
    this.replayUntil = performance.now() + ms;
  }

  /** Desktop browser fallback: treated like live samples. */
  emitBrowser(s: MotionSample) {
    this.emitLive(s);
  }

  private emitLive(s: MotionSample) {
    if (performance.now() < this.replayUntil) return;
    this.emit(s);
  }

  send(ev: NativeEvent) {
    this.port?.postMessage(JSON.stringify(ev));
  }

  get native() {
    return this.port !== null;
  }

  private onNative(raw: unknown) {
    if (typeof raw !== "string") return;
    let msg: { type?: string; name?: string; g?: number[]; a?: number[]; w?: number[]; [k: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.type === "string" && VOICE_TYPES.has(msg.type)) {
      this.emitVoice(msg as VoiceEvent);
      return;
    }
    const sensor = parseSensor(msg);
    if (sensor) {
      for (const l of this.sensorListeners) l(sensor);
      return;
    }
    const mag = parseMag(msg);
    if (mag) {
      this.emitMag(mag);
      return;
    }
    if (msg.type === "fix" || msg.type === "fixError" || msg.type === "sky") {
      for (const l of this.fixListeners) l(msg as FixEvent);
      return;
    }
    if (msg.type === "knock" || msg.type === "knocks") {
      this.emitKnock(msg);
      return;
    }
    if (msg.type === "vision" || msg.type === "visionError") {
      this.emitVision(msg as VisionEvent);
      return;
    }
    if (msg.type === "button" && (msg.name === "back" || msg.name === "look" || msg.name === "map" || msg.name === "metal" || msg.name === "talkStart" || msg.name === "talkEnd")) {
      for (const l of this.buttonListeners) l(msg.name);
      return;
    }
    if (msg.type !== "motion" || !msg.g || !msg.a || !msg.w) return;
    this.emitLive({
      t: performance.now(), // one clock for everything (the app's uptime clock would not match replays)
      gravity: [msg.g[0], msg.g[1], msg.g[2]],
      linear: [msg.a[0], msg.a[1], msg.a[2]],
      gyro: [msg.w[0], msg.w[1], msg.w[2]],
    });
  }
}
