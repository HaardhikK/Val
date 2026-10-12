// The map feature's front door: lazy loading of the map script, warming it up (laid out and drawing, but invisible)
// while Val unrolls his scroll, and the open/close transition: the dark map grows out of the scroll in Val's hands
// and shrinks back into it (transform and opacity only). The heavy part (map/map.js: MapLibre, tiles, search,
// routing) loads on the first preload() or open().
import type { MapImpl } from "./view";
import type { Result } from "./search";
import { fixTime } from "../transit/trip";

export type { Result } from "./search";

export interface MapView {
  /**
   * Opens the map; with a place, also searches it and routes there. Resolves when the map is showing (true), or
   * false if it could not load. With `from` (a screen point, CSS px), the map grows out of that point (the scroll).
   */
  open(place?: string, from?: { x: number; y: number }): Promise<boolean>;
  /** Loads the map and lets it draw its first tiles invisibly (while Val unrolls his scroll). */
  preload(): Promise<void>;
  /**
   * Once, in idle time after start-up: make the map (script, the tiles archive, style, glyphs, sprites, a first
   * frame at the default view) invisibly, then keep the instance alive but undisplayed. The first open is then fast.
   */
  prewarm(): Promise<void>;
  /** Shrinks the map back into the scroll (or just stops warming it up if it never opened). Resolves when gone. */
  close(): Promise<void>;
  /** A GPS fix from the app. Cheap; call it whenever one arrives, open or not. */
  /** [ageMs]: how old the fix already was when the app sent it (the chip's last known fix can be minutes old). */
  setFix(lat: number, lon: number, accuracyM: number, headingDeg?: number, ageMs?: number): void;
  /** The app reported `fixError gpsOff`: the map shows "turn on location" until the next fix. */
  setGpsOff(): void;
  /** Satellites the GPS chip hears (the app's `sky` message): the no-fix strip says "5 seen, 0 locked". */
  setSky(total: number, used: number, best: number): void;
  /** Place search, nearest first (loads the map data if needed). */
  search(query: string): Promise<Result[]>;
  /** Routes from the current fix to a search result (or shows an arrow and the distance). */
  routeTo(result: Result): Promise<void>;
  /** By tram or bus to a place ("home" = the saved home), from `from` or the map's fix; resolves with Val's line. */
  transitTo(dest: string, mode: string, from?: { lat: number; lon: number }): Promise<string>;
  /** A stop's next departures (the nearest stop when empty) on the card; resolves with Val's line. */
  departures(stop: string, mode: string): Promise<string>;
  /** A trip question waits for GPS: the card says "Finding you…" (only once the map has loaded). */
  findingYou(dest: string): void;
  /** A plain open (no place, no trip) starts clean: no old destination, journey, card or search text. */
  reset(): void;
  /** The app was unsure of the next place asked for: its card shows "DID YOU MEAN?" and these heard words. */
  guess(heard: string): void;
  readonly isOpen: boolean;
  /** A reveal or open wants the map shown (cleared by close()). */
  readonly wanted: boolean;
  /** A close() is still running (the map shrinking back). */
  readonly closing: boolean;
}

export interface MapOptions {
  /** Called the moment the map starts to grow over the page (the page may stop drawing; its last frame stays). */
  onGrow?: () => void;
  /** Called when the map starts to close (the close button, or close()), before it shrinks back. */
  onClosing?: () => void;
  /** Called after the map has closed (the close button, or close()). */
  onClose?: () => void;
  log?: (msg: string) => void;
  /** A trip that waited for GPS was planned on a late fix, or the ride chip was tapped: Val says this line. */
  onTripLine?: (line: string) => void;
  /** Folder of map.js, the tiles and the derived data, relative to the page. */
  base?: string;
}

/** The map grows out of the scroll in this long, and shrinks back a little faster. */
export const GROW_MS = 260;
export const SHRINK_MS = 220;
/** The map's size at the start of the grow: about the scroll's sheet on screen. */
export const SCROLL_SCALE = 0.16;

// warm: laid out and drawing, but invisible and untouchable (Val is unrolling the scroll). on: visible. shown: grown.
const CSS = `
.cm-root{position:fixed;inset:0;z-index:10;display:none;contain:strict}
.cm-root.warm{display:block;visibility:hidden;pointer-events:none}
.cm-root.warm.on{visibility:visible;pointer-events:auto}
.cm-stage{position:absolute;inset:0;opacity:0;transform:scale(${SCROLL_SCALE});transform-origin:var(--cm-ox,50%) var(--cm-oy,62%);
 transition:transform var(--cm-ms) cubic-bezier(.2,.8,.2,1),opacity var(--cm-ms) var(--out,ease-out)}
.cm-root.shown .cm-stage{opacity:1;transform:none}
.cm-close{position:absolute;right:16px;top:calc(env(safe-area-inset-top,0px) + 16px);width:48px;height:48px;padding:0;z-index:2;
 border:2px solid var(--cream,#f4ead5);background:#000;color:var(--cream,#f4ead5);font:400 24px/1 var(--mono,monospace);
 opacity:0;transition:opacity var(--cm-ms) var(--out,ease-out)}
.cm-root.shown .cm-close{opacity:1}
.cm-close:active{background:var(--cream,#f4ead5);color:#000}
`;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The next painted frame (or 50 ms, if the page is hidden and frames have stopped). */
const nextFrame = () => new Promise<void>((r) => {
  requestAnimationFrame(() => r());
  setTimeout(r, 50);
});
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}

export function createMap(container: HTMLElement, options: MapOptions = {}): MapView {
  const base = options.base ?? "map/";
  const log = (m: string) => options.log?.(`map ${m}`);
  if (!document.getElementById("cm-css")) {
    const style = document.createElement("style");
    style.id = "cm-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const root = document.createElement("div");
  root.className = "cm-root";
  root.innerHTML = `<div class="cm-stage"></div><button class="cm-close" aria-label="Close map">×</button>`;
  container.appendChild(root);
  const stage = root.querySelector(".cm-stage") as HTMLDivElement;
  root.querySelector(".cm-close")!.addEventListener("click", () => void view.close());

  let impl: Promise<MapImpl> | null = null;
  let lastFix: Parameters<MapImpl["setFix"]>[0] | null = null;
  let gpsOff = false;
  let pendingGuess: string | null = null; // a guess asked for before the map script was made
  let open = false;
  let drawing = false; // the map element is displayed and sized (warm or open)
  let busy: Promise<unknown> = Promise.resolve(); // open/close run one at a time
  let closes = 0; // bumped on every close() call: an open still queued behind it is cancelled
  let wanted = false; // a reveal or open wants the map shown: an idle prewarm must not cool it afterwards
  let closingRuns = 0; // close() calls not finished yet

  function load(): Promise<MapImpl> {
    impl ??= (async () => {
      const w = window as unknown as { CharmMapImpl?: { create: typeof import("./view").create } };
      if (!w.CharmMapImpl) await loadScript(`${base}map.js`);
      if (!w.CharmMapImpl) throw new Error("map script did not start");
      const m = await w.CharmMapImpl.create(stage, base, (line) => options.onTripLine?.(line));
      if (lastFix) m.setFix(lastFix);
      if (gpsOff) m.setGpsOff();
      if (pendingGuess) m.guess(pendingGuess);
      pendingGuess = null;
      return m;
    })();
    impl.catch(() => (impl = null)); // let a later open() retry
    return impl;
  }

  /** Laid out at full size and drawing its tiles, still invisible: the open is then only a transform. */
  async function warm(): Promise<MapImpl> {
    const t0 = performance.now();
    root.classList.add("warm"); // before the map exists, so MapLibre measures a real container
    const m = await load();
    if (!root.classList.contains("warm")) return m; // cooled meanwhile (the open was cancelled)
    if (!drawing) {
      drawing = true;
      m.show(); // one layout read (MapLibre resize), during the reveal rather than the open
    }
    await m.ready;
    log(`warm in ${Math.round(performance.now() - t0)} ms`);
    return m;
  }

  function cool() {
    root.classList.remove("warm", "on", "shown");
    if (!drawing) return;
    drawing = false;
    impl?.then((m) => m.hide()).catch(() => undefined);
  }

  function ms(full: number) {
    const v = reducedMotion() ? 120 : full;
    root.style.setProperty("--cm-ms", `${v}ms`);
    return v;
  }

  const view: MapView = {
    get isOpen() {
      return open;
    },
    get wanted() {
      return wanted;
    },
    get closing() {
      return closingRuns > 0;
    },
    preload() {
      wanted = true;
      return warm().then(() => undefined);
    },
    prewarm() {
      if (impl) return Promise.resolve(); // already made (or being made)
      const t0 = performance.now();
      return warm().then(
        () => {
          log(`prewarmed in ${Math.round(performance.now() - t0)} ms`);
          if (!wanted && !open) cool(); // kept alive, just not displayed until the next reveal
        },
        (err) => {
          log(`prewarm failed: ${err}`);
          if (!wanted && !open) cool();
        },
      );
    },
    open(place, from) {
      wanted = true;
      const epoch = closes;
      const run = busy.then(async (): Promise<boolean> => {
        if (open) {
          if (place) await (await load()).goTo(place);
          return true;
        }
        let m: MapImpl;
        try {
          m = await warm();
        } catch (err) {
          log(`could not load: ${err}`);
          cool();
          return false;
        }
        if (epoch !== closes) return false; // closed while it was still warming up: never grows
        open = true;
        const t = ms(GROW_MS);
        root.style.setProperty("--cm-ox", from ? `${Math.round(from.x)}px` : "50%");
        root.style.setProperty("--cm-oy", from ? `${Math.round(from.y)}px` : "62%");
        root.classList.add("on");
        await nextFrame(); // the start (scroll-sized, transparent) is committed before the grow
        root.classList.add("shown");
        log("grow");
        options.onGrow?.();
        await wait(t);
        if (place && open) await m.goTo(place);
        return true;
      });
      busy = run.catch(() => undefined); // one failed step never blocks the next
      return run;
    },
    close() {
      closes++;
      wanted = false;
      closingRuns++;
      const run = busy.then(async () => {
        if (!open) return cool();
        options.onClosing?.();
        root.classList.remove("shown");
        await wait(ms(SHRINK_MS));
        cool();
        open = false;
        options.onClose?.();
      });
      void run.finally(() => closingRuns--).catch(() => undefined);
      busy = run.catch(() => undefined); // one failed step never blocks the next
      return run;
    },
    setFix(lat, lon, accuracyM, headingDeg, ageMs) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      const heading = Number.isFinite(headingDeg) ? headingDeg : undefined;
      lastFix = { lat, lon, acc: Number.isFinite(accuracyM) ? accuracyM : 50, heading, at: fixTime(performance.now(), ageMs) };
      gpsOff = false;
      impl?.then((m) => m.setFix(lastFix!)).catch(() => undefined);
    },
    setGpsOff() {
      gpsOff = true;
      impl?.then((m) => m.setGpsOff()).catch(() => undefined);
    },
    setSky(total, used, best) {
      if (![total, used, best].every((n) => Number.isFinite(n) && n >= 0)) return;
      impl?.then((m) => m.setSky({ total, used, best })).catch(() => undefined); // only once the map has loaded
    },
    async search(query) {
      return (await load()).search(query);
    },
    async routeTo(result) {
      return (await load()).routeTo(result);
    },
    async transitTo(dest, mode, from) {
      return (await load()).transitTo(dest, mode, from);
    },
    async departures(stop, mode) {
      return (await load()).departures(stop, mode);
    },
    findingYou(dest) {
      impl?.then((m) => m.findingYou(dest)).catch(() => undefined);
    },
    guess(heard) {
      if (impl) impl.then((m) => m.guess(heard)).catch(() => undefined);
      else pendingGuess = heard;
    },
    reset() {
      pendingGuess = null;
      impl?.then((m) => m.reset()).catch(() => undefined); // not made yet: it starts clean anyway
    },
  };
  // Test hook: only in debug mode (`?debug`), never in normal use.
  if (new URLSearchParams(location.search).has("debug")) (window as unknown as { charmMap: MapView }).charmMap = view;
  return view;
}
