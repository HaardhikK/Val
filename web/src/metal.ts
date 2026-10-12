// The metal detector mode: the app streams the magnetometer ({type:"mag", ut, delta} at ≤10 Hz, Metal.kt) while the
// mode is on; a small retro meter fills with the deviation from the room's field, Val's eyes widen and the haptic
// ticks speed up ("warmer… hot!"). The logic is pure (the meter, character and app arrive as plain functions), so it
// is unit-tested without the DOM or three.js. The meter animates with transform and opacity only.
import type { MagEvent, NativeEvent } from "./bridge";

/** Thresholds in µT of deviation from the room's baseline (delta). A fridge magnet near the phone reads 200+. */
export const METAL = {
  warm: 12, // below this is sensor noise and hand tilt: calm
  hot: 60, // HOT from here…
  hotExit: 45, // …until it falls below this (no flicker at the edge)
  spike: 150, // a big hop and one spoken line, once per mode entry
  full: 200, // the bar is full here
  segments: 12,
  warmGapMs: [900, 300] as const, // tick gap from just warm to almost hot
  hotGapMs: 220,
};

export type Heat = "calm" | "warm" | "hot";

export const LINES = {
  enter: "Move me around — I'll sniff out magnets!",
  spike: "Ooh! Something magnetic!",
  exit: "All done sniffing!",
  stop: "Okay, stopping!",
  noSensor: "Hmm, my magnet nose doesn't work on this phone.",
};

/** 0..1 on a log scale, so a steel spoon (~15 µT) and a magnet (~200 µT) both move the bar. */
export function level(delta: number): number {
  if (!(delta > 0)) return 0;
  return Math.min(1, Math.log1p(delta / 5) / Math.log1p(METAL.full / 5));
}

/** How many of the meter's segments are lit for a delta. */
export function litSegments(delta: number): number {
  return Math.round(level(delta) * METAL.segments);
}

/** The next heat for a reading, with hysteresis on HOT. */
export function nextHeat(prev: Heat, delta: number): Heat {
  if (delta >= METAL.hot || (prev === "hot" && delta >= METAL.hotExit)) return "hot";
  return delta >= METAL.warm ? "warm" : "calm";
}

/** Milliseconds between haptic ticks: none when calm, faster as it warms, fastest when hot. */
export function tickGap(heat: Heat, delta: number): number {
  if (heat === "calm") return Infinity;
  if (heat === "hot") return METAL.hotGapMs;
  const k = Math.min(1, Math.max(0, (delta - METAL.warm) / (METAL.hot - METAL.warm)));
  return METAL.warmGapMs[0] + (METAL.warmGapMs[1] - METAL.warmGapMs[0]) * k;
}

/** The meter's words: the deviation the bar shows (METAL ▸ +12 µT), not the absolute field. */
export const meterLabel = (delta: number | null) => `METAL ▸ ${delta === null || !Number.isFinite(delta) ? "--" : `+${Math.round(Math.max(0, delta))}`} µT`;

export interface MeterApi {
  show(): void;
  hide(): void;
  /** [delta]: µT above the room's baseline (what the bar shows); null before the first reading. */
  set(delta: number | null, lit: number, heat: Heat): void;
}

export interface MetalDeps {
  send(e: NativeEvent): void;
  /** Speak (or, with the voice off, show) one line. */
  speak(text: string): void;
  log(msg: string): void;
  /** Eyes: the "Surprised" mood weight, 0..1. */
  surprise(amount: number): void;
  /** Look (and lean) towards the top of the phone, or back at the viewer. */
  lookUp(on: boolean): void;
  /** The big surprised hop. */
  hop(): void;
  meter: MeterApi;
  clock?: () => number;
}

export interface Metal {
  readonly on: boolean;
  readonly heat: Heat;
  open(): void;
  /** Close the mode; `spoken` adds the short exit line (the volume key), a voice "stop" has its own reply. */
  close(spoken?: boolean): void;
  feed(e: MagEvent): void;
}

export function createMetalLogic(d: MetalDeps): Metal {
  const clock = d.clock ?? (() => performance.now());
  let on = false;
  let heat: Heat = "calm";
  let spiked = false;
  let nextTick = 0;
  let shownSurprise = -1;

  const api: Metal = {
    get on() {
      return on;
    },
    get heat() {
      return heat;
    },
    open() {
      if (on) return;
      on = true;
      heat = "calm";
      spiked = false;
      nextTick = 0;
      shownSurprise = -1;
      d.send({ type: "metal", on: true });
      d.meter.set(null, 0, "calm");
      d.meter.show();
      d.log("metal on");
    },
    close(spoken = false) {
      if (!on) return;
      on = false;
      d.send({ type: "metal", on: false });
      d.meter.hide();
      d.surprise(0);
      d.lookUp(false);
      d.log("metal off");
      if (spoken) d.speak(LINES.exit);
    },
    feed(e) {
      if (!on) return;
      if (e.type === "magError") {
        d.log(`metal error ${e.reason}`);
        api.close();
        d.speak(LINES.noSensor);
        return;
      }
      const prev = heat;
      heat = nextHeat(heat, e.delta);
      d.meter.set(e.delta, litSegments(e.delta), heat);
      // Eyes widen with the reading; only sent when it moves visibly (the mood blend does the smoothing).
      const s = heat === "calm" ? 0 : Math.round((0.15 + 0.85 * level(e.delta)) * 20) / 20;
      if (s !== shownSurprise) {
        shownSurprise = s;
        d.surprise(s);
      }
      if (heat !== prev && (heat === "calm" || prev === "calm")) d.lookUp(heat !== "calm");
      if (heat === "hot" && prev !== "hot") d.log("metal hot");
      const now = clock();
      if (e.delta >= METAL.spike && !spiked) {
        spiked = true;
        d.hop();
        d.send({ type: "haptic", pattern: "tumble" });
        d.speak(LINES.spike);
        nextTick = now + 600; // let the big buzz finish
        return;
      }
      if (now >= nextTick && heat !== "calm") {
        d.send({ type: "haptic", pattern: heat === "hot" ? "bump" : "tick" });
        nextTick = now + tickGap(heat, e.delta);
      }
    },
  };
  return api;
}

// ---- The meter: METAL ▸ +12 µT (above the room) and a 12-segment bar, at the bottom above the voice strip ----

const CSS = `
#metal {
  position: fixed; z-index: 20; left: 50%;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 7% + 46px);
  display: flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box; width: 236px; height: 40px; padding: 0 12px; /* the voice strip's size (index.html) */
  border: 2px solid var(--cream); background: var(--bg); color: var(--cream);
  opacity: 0; transform: translate(-50%, 8px); transition: opacity 240ms var(--out), transform 240ms var(--out);
  pointer-events: none;
}
#metal.on { opacity: 1; transform: translate(-50%, 0); }
#metal .label, #metal .hot { font: 600 10px/1 var(--mono); letter-spacing: 0.08em; white-space: nowrap; }
#metal .label { min-width: 96px; }
#metal .hot { color: var(--pink); opacity: 0; transition: opacity 120ms linear; }
#metal.is-hot .hot { opacity: 1; animation: metal-blink .5s steps(1) infinite; }
@keyframes metal-blink { 50% { opacity: 0.25; } }
#metal .bar { display: flex; align-items: flex-end; gap: 2px; height: 22px; }
#metal .bar i { position: relative; width: 4px; height: 22px; background: var(--cream); opacity: 0.18; transform: scaleY(0.35);
  transform-origin: bottom; transition: transform 90ms linear, opacity 90ms linear; }
#metal .bar i.amber { background: var(--amber); }
#metal .bar i::after { content: ""; position: absolute; inset: 0; background: var(--pink); opacity: 0; transition: opacity 120ms linear; }
#metal .bar i.lit { opacity: 1; transform: scaleY(1); }
#metal.is-hot .bar i.lit::after { opacity: 1; }
`;

/** Segments from here on are amber: the bar turns amber as it climbs. */
const AMBER_FROM = 4;

export function createMeter(doc: Document = document): MeterApi {
  const style = doc.createElement("style");
  style.textContent = CSS;
  doc.head.appendChild(style);
  const root = doc.createElement("div");
  root.id = "metal";
  root.setAttribute("role", "status");
  const label = doc.createElement("span");
  label.className = "label";
  const bar = doc.createElement("span");
  bar.className = "bar";
  const segs: HTMLElement[] = [];
  for (let i = 0; i < METAL.segments; i++) {
    const s = doc.createElement("i");
    if (i >= AMBER_FROM) s.className = "amber";
    bar.appendChild(s);
    segs.push(s);
  }
  const hot = doc.createElement("span");
  hot.className = "hot";
  hot.textContent = "HOT!";
  root.append(label, bar, hot);
  doc.body.appendChild(root);

  let lastLit = -1;
  let lastText = "";
  return {
    show() {
      root.classList.add("on");
    },
    hide() {
      root.classList.remove("on", "is-hot");
    },
    set(delta, lit, heat) {
      const text = meterLabel(delta);
      if (text !== lastText) label.textContent = lastText = text;
      if (lit !== lastLit) {
        segs.forEach((s, i) => s.classList.toggle("lit", i < lit));
        lastLit = lit;
      }
      root.classList.toggle("is-hot", heat === "hot");
    },
  };
}
