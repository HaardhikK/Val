// The countdown timer: a 4px line runs round the whole screen edge and drains clockwise from the top centre as time
// passes (green, amber for the last 20 %, pulsing pink for the last 10 s), with a tiny "▸ 04:32" readout. One timer
// at a time; "focus" is a Pomodoro where Val sits still. The end time is kept in localStorage, so a reload resumes it.
// Cheap by design: one SVG path whose stroke-dashoffset moves at most 4×/s (no layout, no WebGL redraw), the readout
// text changes once a second, stage colours are classes. The pure parts (formatting, fraction, stage, saved state)
// are unit-tested; createTimer is the DOM side.
import type { NativeEvent } from "./bridge";

export const TIMER = {
  amberAt: 0.2, // the last 20 % of the time is amber
  pinkMs: 10_000, // the last 10 s are pink, with a soft tick every second
  fillMs: 600, // on start the line runs round the edge in this long
  tickMs: 250, // the line moves at most 4×/s
  flashMs: 900, // three flashes at zero
  minMs: 1000,
  maxMs: 180 * 60_000,
  staleMs: 60 * 60_000, // a saved timer that ran out longer ago than this is dropped quietly on load
  focusMinutes: 25,
  key: "charm.timer",
  inset: 3, // px from the screen edge to the line's outer side
  width: 4,
  radius: 18, // follows the phone's rounded screen corners
};

export type Stage = "green" | "amber" | "pink" | "done";

/** Remaining share of the time, 1 (full) … 0 (empty). */
export function fraction(leftMs: number, totalMs: number): number {
  if (!(totalMs > 0)) return 0;
  return Math.min(1, Math.max(0, leftMs / totalMs));
}

/** The colour stage for the time left. */
export function stage(leftMs: number, totalMs: number): Stage {
  if (leftMs <= 0) return "done";
  if (leftMs <= TIMER.pinkMs) return "pink";
  if (leftMs <= totalMs * TIMER.amberAt) return "amber";
  return "green";
}

/** Whole seconds shown for the time left (rounded up, so "00:00" appears only at zero). */
export function shownSeconds(leftMs: number): number {
  return Math.max(0, Math.ceil(leftMs / 1000));
}

const pad = (n: number) => (n < 10 ? "0" : "") + n;

/** "04:32", "1:04:32". */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A duration as Val says it: "30 seconds", "a minute and a half", "5 minutes", "1 hour 30 minutes". */
export function spoken(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return plural(s, "second");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return rest === 0 && m === 0 ? plural(h, "hour") : `${plural(h, "hour")} ${plural(m, "minute")}`;
  if (rest === 0) return plural(m, "minute");
  if (rest === 30) return m === 1 ? "a minute and a half" : `${m} and a half minutes`;
  return `${plural(m, "minute")} ${plural(rest, "second")}`;
}

/** A label from the app as a name to say: "pasta" → "Pasta". Letters, spaces and apostrophes only, ≤ 24 chars. */
export function cleanLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.replace(/[^a-zA-Zäöüß' ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 24);
  return t ? t[0].toUpperCase() + t.slice(1) : undefined;
}

/** What Val says at zero. */
export function doneLine(label?: string, focus?: boolean): string {
  if (focus) return "Focus time's over! Take a little break.";
  if (label) return /[^s]s$/i.test(label) ? `${label} are done!` : `${label}'s done!`; // "Eggs are done!", "Pasta's done!"
  return "Time's up!";
}

/** What the page tells the assistant about the running timer (assistant.ts words the replies). */
export interface TimerSnapshot {
  leftMs: number;
  totalMs: number;
  paused: boolean;
  label?: string;
  focus?: boolean;
}

/** The saved timer: an absolute end time (Date.now based), or the time left while paused. */
export interface Saved {
  end: number;
  total: number;
  label?: string;
  focus?: boolean;
  pausedLeft?: number;
}

export function parseSaved(raw: string | null): Saved | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Saved>;
    if (typeof v.end !== "number" || typeof v.total !== "number" || !(v.total > 0) || v.total > TIMER.maxMs) return null;
    const out: Saved = { end: v.end, total: v.total };
    const label = cleanLabel(v.label);
    if (label) out.label = label;
    if (v.focus === true) out.focus = true;
    if (typeof v.pausedLeft === "number" && v.pausedLeft > 0 && v.pausedLeft <= v.total + TIMER.maxMs) out.pausedLeft = v.pausedLeft;
    return out;
  } catch {
    return null;
  }
}

/** On load: keep running, show paused, ring at once (ran out while the page was gone), or drop it (long stale). */
export function onLoad(saved: Saved | null, now: number): "none" | "run" | "paused" | "fire" | "drop" {
  if (!saved) return "none";
  if (saved.pausedLeft !== undefined) return "paused";
  if (saved.end > now) return "run";
  return now - saved.end <= TIMER.staleMs ? "fire" : "drop";
}

/**
 * The SVG path round the screen edge for a w×h screen: starts at the top centre and runs clockwise, with rounded
 * corners. Returns the path and its length (to drive the dash).
 */
export function edgePath(w: number, h: number): { d: string; length: number } {
  const o = TIMER.inset + TIMER.width / 2; // the stroke's centre line
  const r = TIMER.radius;
  const x0 = o, y0 = o, x1 = w - o, y1 = h - o;
  const cx = w / 2;
  const d =
    `M${cx} ${y0}H${x1 - r}A${r} ${r} 0 0 1 ${x1} ${y0 + r}V${y1 - r}A${r} ${r} 0 0 1 ${x1 - r} ${y1}` +
    `H${x0 + r}A${r} ${r} 0 0 1 ${x0} ${y1 - r}V${y0 + r}A${r} ${r} 0 0 1 ${x0 + r} ${y0}Z`;
  const length = 2 * (x1 - x0 - 2 * r) + 2 * (y1 - y0 - 2 * r) + 2 * Math.PI * r;
  return { d, length };
}

/**
 * The dash offset for a remaining share f, with dasharray "L L": 0 shows the whole line, -(1-f)·L hides the first
 * (1-f) of it, so the line drains clockwise from the top centre. During the start fill the offset runs L → 0
 * instead, so the line grows clockwise.
 */
export function drainOffset(f: number, length: number): number {
  return -(1 - f) * length;
}

// The pulse and the paused dimming are on the svg element, not the path: opacity on the svg is composited, on a path
// inside it the whole full-screen svg repaints every frame.
const CSS = `
#timer-edge{position:fixed;z-index:45;top:env(safe-area-inset-top,0px);left:env(safe-area-inset-left,0px);
right:env(safe-area-inset-right,0px);bottom:env(safe-area-inset-bottom,0px);pointer-events:none;display:none}
#timer-edge.on{display:block}
#timer-edge svg{display:block;width:100%;height:100%;overflow:visible}
#timer-edge path{fill:none;stroke:#7cff9b;stroke-width:${TIMER.width}px;stroke-linecap:butt;transition:stroke 400ms linear}
#timer-edge.amber path{stroke:var(--amber,#ffb000)}
#timer-edge.pink path{stroke:var(--pink,#ffb3c8)}
#timer-edge.pink svg{animation:timer-pulse 1s ease-in-out infinite}
#timer-edge.paused svg{opacity:.35;animation:none}
#timer-edge.flash svg,#timer-edge.flash .tm{animation:timer-flash ${TIMER.flashMs / 3}ms steps(1) 3}
#timer-edge .tm{position:absolute;top:10px;right:12px;padding:3px 6px;background:var(--bg,#000);border:2px solid currentColor;
color:#7cff9b;font:600 12px/1 var(--mono,ui-monospace,monospace);letter-spacing:.08em;white-space:nowrap;transition:color 400ms linear}
#timer-edge.amber .tm{color:var(--amber,#ffb000)}
#timer-edge.pink .tm{color:var(--pink,#ffb3c8)}
#timer-edge.paused .tm{color:var(--text-3,rgba(244,234,213,.45))}
#timer-edge.low .tm{top:auto;right:auto;bottom:6px;left:12px;padding:2px 5px;font-size:11px}
@keyframes timer-pulse{50%{opacity:.35}}
@keyframes timer-flash{50%{opacity:0}}
`;

export interface TimerDeps {
  send(e: NativeEvent): void;
  log(msg: string): void;
  /** Zero: Val dances, hearts, and says the line (main.ts). */
  onDone(label: string | undefined, focus: boolean): void;
  now?: () => number;
}

export interface Timer {
  readonly focus: boolean;
  snapshot(): TimerSnapshot | null;
  start(seconds: number, label?: string, focus?: boolean): void;
  cancel(): void;
  add(seconds: number): void;
  pause(): void;
  resume(): void;
  /** A feature overlay is open: the readout moves to the bottom-left, clear of the close buttons and below the map card. */
  setOverlay(on: boolean): void;
  /** Pick up a saved timer after a reload (call once the character can react). */
  restore(): void;
}

export function createTimer(deps: TimerDeps): Timer {
  const now = deps.now ?? Date.now;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "timer-edge";
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const path = document.createElementNS(ns, "path");
  svg.appendChild(path);
  const readout = document.createElement("div");
  readout.className = "tm";
  root.append(svg, readout);
  document.body.appendChild(root);

  let state: Saved | null = null;
  let length = 0;
  let shownOffset = NaN;
  let shownSecs = -1;
  let shownStage: Stage | "" = "";
  let tick: number | undefined;
  let fillDone: number | undefined;
  let flashEnd: number | undefined;

  const save = () => {
    try {
      if (state) localStorage.setItem(TIMER.key, JSON.stringify(state));
      else localStorage.removeItem(TIMER.key);
    } catch {
      /* storage blocked: the timer still runs, it just does not survive a reload */
    }
  };

  const leftMs = () => (!state ? 0 : state.pausedLeft ?? state.end - now());

  function layout() {
    const w = root.clientWidth || window.innerWidth;
    const h = root.clientHeight || window.innerHeight;
    const p = edgePath(w, h);
    length = p.length;
    path.setAttribute("d", p.d);
    path.style.strokeDasharray = `${length} ${length}`;
    shownOffset = NaN;
  }

  function setOffset(offset: number, ms: number) {
    // Below a pixel the line would not visibly move: skip the repaint.
    if (Math.abs(offset - shownOffset) < 1 && ms === 0) return;
    path.style.transition = ms ? `stroke-dashoffset ${ms}ms linear, stroke 400ms linear` : "stroke 400ms linear";
    path.style.strokeDashoffset = String(offset);
    shownOffset = offset;
  }

  function setStage(s: Stage) {
    if (s === shownStage) return;
    root.classList.remove("green", "amber", "pink");
    if (s !== "done") root.classList.add(s);
    shownStage = s;
  }

  function update() {
    if (!state) return;
    const left = leftMs();
    const secs = shownSeconds(left);
    if (secs !== shownSecs) {
      shownSecs = secs;
      readout.textContent = (state.pausedLeft !== undefined ? "❚❚ " : "▸ ") + clockText(secs);
      if (state.pausedLeft === undefined && left > 0 && left <= TIMER.pinkMs) deps.send({ type: "haptic", pattern: "tick" });
    }
    setStage(stage(left, state.total));
    // Short timers move many pixels per step: glide between steps; long ones jump sub-pixel steps without a transition.
    const offset = drainOffset(fraction(left, state.total), length);
    const step = (length * TIMER.tickMs) / state.total;
    setOffset(offset, state.pausedLeft === undefined && step > 2 ? TIMER.tickMs : 0);
    if (left <= 0 && state.pausedLeft === undefined) finish();
  }

  function schedule() {
    clearInterval(tick);
    tick = window.setInterval(update, TIMER.tickMs);
  }

  function clearTimers() {
    clearInterval(tick);
    clearTimeout(fillDone);
    clearTimeout(flashEnd);
    tick = fillDone = flashEnd = undefined;
  }

  function show(fill: boolean) {
    clearTimers();
    root.classList.remove("flash");
    root.classList.add("on");
    layout();
    shownSecs = -1;
    shownStage = "";
    root.classList.toggle("paused", state?.pausedLeft !== undefined);
    if (fill && state) {
      // The line runs round the edge clockwise (offset L → its current drain), then the countdown takes over.
      setOffset(length, 0);
      void path.getBoundingClientRect(); // commit the empty line before the transition starts
      setOffset(drainOffset(fraction(leftMs(), state.total), length), TIMER.fillMs);
      setStage(stage(leftMs(), state.total));
      readout.textContent = "▸ " + clockText(shownSeconds(leftMs()));
      deps.send({ type: "haptic", pattern: "tick" });
      fillDone = window.setTimeout(() => {
        update();
        schedule();
      }, TIMER.fillMs);
      return;
    }
    update();
    if (state && state.pausedLeft === undefined) schedule();
  }

  function hide() {
    clearTimers();
    root.classList.remove("on", "flash", "paused", "green", "amber", "pink");
    shownStage = "";
  }

  function finish() {
    if (!state) return;
    const { label, focus } = state;
    state = null;
    save();
    clearTimers();
    setStage("pink");
    readout.textContent = "▸ 00:00";
    setOffset(0, 0); // the full line flashes three times, then goes
    root.classList.add("flash");
    flashEnd = window.setTimeout(hide, TIMER.flashMs);
    deps.log(`timer done${label ? ` (${label})` : ""}`);
    deps.onDone(label, focus === true);
  }

  window.addEventListener("resize", () => {
    if (!state) return;
    layout();
    update();
  });

  return {
    get focus() {
      return state?.focus === true && state.pausedLeft === undefined;
    },
    snapshot() {
      if (!state) return null;
      return { leftMs: Math.max(0, leftMs()), totalMs: state.total, paused: state.pausedLeft !== undefined, label: state.label, focus: state.focus };
    },
    start(seconds, label, focus) {
      const ms = Math.min(TIMER.maxMs, Math.max(TIMER.minMs, Math.round(seconds * 1000)));
      state = { end: now() + ms, total: ms };
      const name = cleanLabel(label);
      if (name) state.label = name;
      if (focus) state.focus = true;
      save();
      deps.log(`timer start ${Math.round(ms / 1000)} s${name ? ` (${name})` : ""}${focus ? " focus" : ""}`);
      show(true);
    },
    cancel() {
      if (!state) return;
      state = null;
      save();
      deps.log("timer cancelled");
      hide();
    },
    add(seconds) {
      if (!state) return;
      const ms = Math.round(seconds * 1000);
      const left = Math.min(TIMER.maxMs, leftMs() + ms);
      if (state.pausedLeft !== undefined) state.pausedLeft = left;
      else state.end = now() + left;
      state.total = Math.max(state.total, left);
      save();
      deps.log(`timer add ${Math.round(ms / 1000)} s`);
      show(false);
    },
    pause() {
      if (!state || state.pausedLeft !== undefined) return;
      state.pausedLeft = Math.max(0, state.end - now());
      save();
      deps.log("timer paused");
      show(false);
    },
    resume() {
      if (!state || state.pausedLeft === undefined) return;
      state.end = now() + state.pausedLeft;
      delete state.pausedLeft;
      save();
      deps.log("timer resumed");
      show(false);
    },
    setOverlay(on) {
      root.classList.toggle("low", on);
    },
    restore() {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(TIMER.key);
      } catch {
        /* storage blocked */
      }
      const saved = parseSaved(raw);
      const what = onLoad(saved, now());
      if (what !== "none") deps.log(`timer restore: ${what}`);
      if (what === "none") return;
      if (what === "drop") {
        state = null;
        save();
        return;
      }
      state = saved;
      if (what === "fire") finish();
      else show(false);
    },
  };
}
