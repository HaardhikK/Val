// The map itself (MapLibre + PMTiles + search + routing). Built as its own script, map/map.js, and loaded
// only when the map first opens (index.ts), so the character page starts without ~1 MB of map code.
import * as maplibregl from "maplibre-gl";
import { FileSource, PMTiles, Protocol } from "pmtiles";
import maplibreCss from "maplibre-gl/dist/maplibre-gl.css";
import { pixelRatio } from "../device";
import { bearing, formatDistance, formatWalk, gpsStatusText, haversine, pathLength, trimHooks, type Sky } from "./geo";
import { Router, SnapGrid, decodeGraph, type WalkGraph } from "./graph";
import { ALTSTADT, PlaceIndex, type PoiDoc, type Result } from "./search";
import { charmStyle, poiFilter } from "./style";
import { transitApi, type Journey, type LatLon, type Network, type RideLeg } from "../transit/api";
import {
  boardLabel, departureRows, filterMode, journeyCard, journeyLines, lineColor, modeOfWord, planTrip, rideChip, timetableNote,
  type CardText,
} from "../transit/card";
import { FRESH_FIX_MS, LINES, loadHome, OLD_FIX_MS } from "../transit/trip";

export interface Fix {
  lat: number;
  lon: number;
  acc: number;
  heading?: number;
  at: number;
}

export interface MapImpl {
  /** Resolves once the first tiles are drawn (or after a timeout, so the curtain never hangs). */
  ready: Promise<void>;
  show(): void;
  hide(): void;
  setFix(fix: Fix): void;
  /** The phone's location is switched off: show "turn on location" until the next fix. */
  setGpsOff(): void;
  /** What the GPS chip hears (for the no-fix strip); it goes stale when the messages stop. */
  setSky(sky: Sky): void;
  search(query: string): Promise<Result[]>;
  routeTo(r: Result): Promise<void>;
  /** Voice entry point: find the place and route to the best match, or say it is not on the map. */
  goTo(place: string): Promise<void>;
  /**
   * By tram or bus to a place ("home" = the saved home): plans from `from` (or the map's own fix), draws the journey
   * and its card, and resolves with Val's spoken line. Without a fix the card waits and plans on the first one.
   */
  transitTo(dest: string, mode: string, from?: LatLon): Promise<string>;
  /** Next departures at a stop (the nearest one when empty), shown on the card; resolves with Val's line. */
  departures(stop: string, mode: string): Promise<string>;
  /** A trip question is waiting for GPS: the card says "Finding you…" at once. */
  findingYou(dest: string): void;
  /** A plain open: no old destination, route, journey, card or search text; back on you (or the Altstadt). */
  reset(): void;
  /** The app was unsure of the next place asked for: its card shows "DID YOU MEAN?" and these heard words. */
  guess(heard: string): void;
}

/** The pmtiles fetch target and folder of glyphs and derived data, relative to the page. */
const TILES = "dresden.pmtiles";
const BOUNDS: [[number, number], [number, number]] = [
  [13.55, 50.95],
  [13.99, 51.19],
];
const SNAP_M = 400; // further than this from any footpath → no route, arrow + distance instead
const REROUTE_M = 20;
const REROUTE_MS = 4000;
const ARRIVED_M = 25;
const FIX_STALE_MS = 20_000;
/** The app sends `sky` once a second while GPS is on; older than this, the count is no longer true. */
const SKY_STALE_MS = 5_000;
const MAX_RESULTS = 4;
/**
 * Places indexed per step (~1000 take ~25 ms on the phone; the whole index in one go stalls ~0.45 s). In idle time,
 * steps of IDLE_CHUNK run while the idle deadline has room; a waiting search runs one HURRY_CHUNK per task.
 */
const IDLE_CHUNK = 150;
const HURRY_CHUNK = 300;
/** An idle step stops when less than this is left of its deadline (so no indexing task runs past ~50 ms). */
const IDLE_MARGIN_MS = 5;

/** Shown at once when the search opens empty: the sights most people want, with no index or wait behind them. */
const PRESETS: readonly [name: string, lat: number, lon: number][] = [
  ["Frauenkirche", 51.05192, 13.74163],
  ["Zwinger", 51.05297, 13.73374],
  ["Semperoper", 51.05427, 13.73551],
  ["Brühlsche Terrasse", 51.05305, 13.74402],
];

const CATEGORY_LABEL: Record<string, string> = {
  station: "Stop",
  sight: "Sight",
  pharmacy: "Pharmacy",
  hospital: "Hospital",
  toilets: "Toilets",
  drinking_water: "Water",
  police: "Police",
  building: "Building",
  university: "University",
  food: "Food",
  supermarket: "Shop",
  hotel: "Hotel",
  park: "Park",
  area: "Area",
  street: "Street",
  home: "Home",
};

// Layout: a 16px gutter and an 8px rhythm. Top bar = search (index.ts adds the 48px close button at its
// right); below it, either the GPS strip or the results. Bottom = the route card, with the locate button
// riding just above its right edge, and the attribution line under both.
const CSS = `
.cm-map{position:absolute;inset:0;background:#000}
.cm-hud{--top:calc(env(safe-area-inset-top,0px) + 16px);--bot:calc(env(safe-area-inset-bottom,0px) + 32px);
 position:absolute;inset:0;pointer-events:none;font:500 14px/1.35 var(--mono,monospace);color:var(--cream,#f4ead5)}
.cm-hud>*{pointer-events:auto}
.cm-tag{font:600 11px/1 var(--mono,monospace);letter-spacing:.14em;text-transform:uppercase;white-space:nowrap}
.cm-search{position:absolute;left:16px;right:72px;top:var(--top);height:48px;box-sizing:border-box;
 display:flex;align-items:center;gap:10px;padding:0 12px;border:2px solid var(--cream,#f4ead5);background:#000}
.cm-search .cm-tag{color:var(--pink,#ffb3c8)}
.cm-q{flex:1;min-width:0;height:100%;padding:0;border:0;background:none;color:var(--cream,#f4ead5);font:500 15px/1 var(--mono,monospace);outline:none}
.cm-q::-webkit-search-cancel-button{display:none}
.cm-q::placeholder{color:var(--text-3,rgba(244,234,213,.45))}
.cm-results{position:absolute;left:16px;right:16px;top:calc(var(--top) + 56px);margin:0;padding:0;list-style:none;
 border:2px solid var(--cream,#f4ead5);background:#000;opacity:0;transform:translateY(-8px);visibility:hidden;
 transition:opacity 150ms var(--out),transform 150ms var(--out),visibility 0s 150ms}
.cm-results.on{opacity:1;transform:none;visibility:visible;transition:opacity 150ms var(--out),transform 150ms var(--out)}
.cm-results li{display:flex;align-items:center;gap:12px;min-height:56px;box-sizing:border-box;padding:8px 12px}
.cm-results li+li{border-top:1px solid rgba(244,234,213,.16)}
.cm-results li:active{background:rgba(244,234,213,.12)}
.cm-results li>div{flex:1;min-width:0}
.cm-results b{display:block;font-weight:500;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-results small{display:block;margin-top:2px;color:var(--text-3,rgba(244,234,213,.45));font-size:12px;letter-spacing:.08em;text-transform:uppercase}
.cm-results em{flex:none;font-style:normal;color:var(--amber,#ffb000);font-size:13px}
.cm-results li.cm-empty{color:var(--text-2,rgba(244,234,213,.72))}
.cm-status{position:absolute;left:16px;right:16px;top:calc(var(--top) + 56px);height:36px;box-sizing:border-box;
 display:flex;align-items:center;gap:10px;padding:0 12px;border:2px solid var(--amber,#ffb000);background:#000;
 color:var(--text-2,rgba(244,234,213,.72));font-size:13px;white-space:nowrap;overflow:hidden;
 transition:opacity 220ms var(--out);pointer-events:none}
.cm-status b{font-weight:500;overflow:hidden;text-overflow:ellipsis}
.cm-status.off,.cm-hud.searching .cm-status{opacity:0}
.cm-status .cm-tag{color:var(--amber,#ffb000)}
.cm-status .cm-tag i{font-style:normal;animation:cm-blink 1s steps(1) infinite}
.cm-status.gps-off{border-color:var(--pink,#ffb3c8)}
.cm-status.gps-off .cm-tag{color:var(--pink,#ffb3c8)}
.cm-status.gps-off .cm-tag i{animation:none}
@keyframes cm-blink{50%{opacity:0}}
.cm-card{position:absolute;left:16px;right:16px;bottom:var(--bot);box-sizing:border-box;display:flex;flex-direction:column;gap:12px;
 padding:14px 16px;border:2px solid var(--cream,#f4ead5);background:#000;
 opacity:0;transform:translateY(16px);transition:opacity 220ms var(--out),transform 220ms var(--out);pointer-events:none}
.cm-card.on{opacity:1;transform:none;pointer-events:auto}
.cm-row{display:flex;gap:16px;align-items:center}
.cm-txt{flex:1;min-width:0}
.cm-guess{display:none;margin:0 0 8px;padding:0;border:0;background:none;color:var(--text-2,rgba(244,234,213,.72));
 font:400 12px/1.4 var(--mono,monospace);text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.cm-guess .cm-tag{color:var(--amber,#ffb000);margin-right:6px}
.cm-card.guess .cm-guess{display:block}
.cm-card .cm-arrow{width:32px;height:32px;flex:none;display:none}
.cm-card.arrow .cm-arrow{display:block}
.cm-card b{display:block;font-weight:600;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-card em{display:block;font-style:normal;font-size:15px;color:var(--amber,#ffb000);margin-top:6px}
.cm-card small{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;color:var(--text-3,rgba(244,234,213,.45));font-size:13px;margin-top:4px;overflow:hidden}
.cm-card em:empty,.cm-card small:empty,.cm-legs:empty,.cm-deps:empty{display:none}
.cm-legs{margin:8px 0 0;font-size:12px;line-height:1.45;color:var(--text-2,rgba(244,234,213,.72));letter-spacing:.02em}
.cm-next{flex:none;min-width:64px;height:44px;padding:0 10px;border:2px solid var(--amber,#ffb000);background:#000;color:var(--amber,#ffb000);
 font:600 13px/1 var(--mono,monospace);letter-spacing:.08em;display:none}
.cm-card.many .cm-next{display:block}
.cm-next:active{background:var(--amber,#ffb000);color:#000}
.cm-deps{margin:0;padding:0;list-style:none}
.cm-deps li{display:flex;align-items:center;gap:10px;min-height:30px;font-size:13px}
.cm-deps li+li{border-top:1px solid rgba(244,234,213,.12)}
.cm-deps .t{flex:none;min-width:76px;padding-left:8px;border-left:4px solid;font-weight:600;letter-spacing:.06em}
.cm-deps .h{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-2,rgba(244,234,213,.72))}
.cm-deps .w{flex:none;color:var(--amber,#ffb000)}
.cm-modes{display:none;gap:8px}
.cm-card.modes .cm-modes{display:flex}
.cm-modes button{flex:1;min-height:44px;padding:0 8px;border:2px solid rgba(244,234,213,.35);background:#000;color:var(--cream,#f4ead5);
 font:600 12px/1 var(--mono,monospace);letter-spacing:.14em;text-transform:uppercase}
.cm-modes button.on{border-color:var(--pink,#ffb3c8);color:var(--pink,#ffb3c8)}
.cm-modes button:active{background:var(--cream,#f4ead5);color:#000}
.cm-board{padding:3px 6px;border:2px solid;background:#000;color:var(--cream,#f4ead5);font:600 11px/1 var(--mono,monospace);
 letter-spacing:.08em;white-space:nowrap;pointer-events:none}
.cm-results li.cm-homerow .cm-tag{color:var(--pink,#ffb3c8);flex:none}
.cm-locate{position:absolute;right:16px;bottom:var(--bot);width:48px;height:48px;padding:0;
 border:2px solid var(--cream,#f4ead5);background:#000;color:var(--cream,#f4ead5);font:400 22px/1 var(--mono,monospace);
 transition:transform 220ms var(--out),opacity 220ms var(--out)}
.cm-locate:active{background:var(--cream,#f4ead5);color:#000}
.cm-locate.idle{opacity:.45}
.cm-me{width:44px;height:44px;position:relative;pointer-events:none}
.cm-me i{position:absolute;left:15px;top:15px;width:14px;height:14px;border-radius:50%;background:var(--cream,#f4ead5);box-shadow:0 0 0 2px #000}
.cm-me u{position:absolute;left:12px;top:12px;width:20px;height:20px;border-radius:50%;border:2px solid var(--amber,#ffb000);box-sizing:border-box;
 animation:cm-pulse 1.8s var(--out) infinite}
.cm-me s{position:absolute;left:16px;top:0;width:12px;height:22px;display:none;transform-origin:6px 22px;
 background:var(--amber,#ffb000);opacity:.55;clip-path:polygon(50% 100%,0 0,100% 0)}
.cm-me.heading s{display:block}
.cm-me.stale i{background:var(--text-3,rgba(244,234,213,.45))}
.cm-me.stale u,.cm-me.stale s{animation:none;opacity:0}
@keyframes cm-pulse{0%{transform:scale(.6);opacity:.9}100%{transform:scale(2.2);opacity:0}}
.cm-x{width:36px;height:36px;pointer-events:none}
.cm-x svg{display:block;width:36px;height:36px;transform:scale(0);animation:cm-pop 420ms var(--spring) forwards}
@keyframes cm-pop{to{transform:scale(1)}}
.cm-attr{position:absolute;right:16px;bottom:calc(env(safe-area-inset-bottom,0px) + 8px);max-width:calc(100% - 32px);height:16px;
 box-sizing:border-box;margin:0;padding:0;border:0;background:none;color:var(--text-3,rgba(244,234,213,.45));
 font:10px/16px var(--mono,monospace);letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}
.cm-attr.open{bottom:calc(env(safe-area-inset-bottom,0px) + 32px);height:auto;padding:6px 8px;border:2px solid rgba(244,234,213,.35);background:#000;color:var(--text-2,rgba(244,234,213,.72));
 white-space:normal;text-align:left;z-index:3}
@media (prefers-reduced-motion: reduce){.cm-me u{animation:none;opacity:.6;transform:scale(1.4)}.cm-x svg{animation:none;transform:none}.cm-status .cm-tag i{animation:none}}
`;

/** The credit line: one short line at rest, the full licence text on a tap. */
const ATTR_SHORT = "© OpenStreetMap · DELFI (CC BY)";
const ATTR_FULL = "Map data © OpenStreetMap contributors (ODbL) · Tiles: Protomaps · Timetable: DELFI/gtfs.de (CC BY 4.0)";

const X_SVG = `<svg viewBox="0 0 36 36"><path d="M9 9 27 27M27 9 9 27" stroke="#000" stroke-width="10" stroke-linecap="square"/>
<path d="M9 9 27 27M27 9 9 27" stroke="#ffb3c8" stroke-width="5" stroke-linecap="square"/></svg>`;
/** The saved home: a small house instead of the X. */
const HOME_SVG = `<svg viewBox="0 0 36 36"><path d="M18 6 31 17v13H5V17Z" fill="#000" stroke="#000" stroke-width="6" stroke-linejoin="miter"/>
<path d="M18 7 30 17.5V29H6V17.5Z" fill="#ffb3c8"/><path d="M15 29v-8h6v8" fill="#000"/></svg>`;
const ARROW_SVG = `<svg class="cm-arrow" viewBox="0 0 34 34"><path d="M17 3 28 29 17 23 6 29Z" fill="#ffb000"/></svg>`;

let installed = false;
/** One-time page setup for the map script: styles, and a polyfill pmtiles needs on Chrome 94. */
function installOnce() {
  if (installed) return;
  installed = true;
  // pmtiles calls AbortSignal.throwIfAborted (Chrome 100+); the phone's WebView is 94.
  const proto = AbortSignal.prototype as AbortSignal & { throwIfAborted?: () => void };
  if (!proto.throwIfAborted) {
    proto.throwIfAborted = function (this: AbortSignal) {
      if (this.aborted) throw new DOMException("Aborted", "AbortError");
    };
  }
  const style = document.createElement("style");
  style.textContent = maplibreCss + CSS;
  document.head.appendChild(style);
  maplibregl.setWorkerCount(2); // the phone has 8 small cores and the robot keeps drawing: two tile workers
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res;
}

function circle(lat: number, lon: number, radiusM: number, steps = 48): GeoJSON.Feature<GeoJSON.Polygon> {
  const ring: [number, number][] = [];
  const dLat = radiusM / 111_320;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}

const empty = (): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: [] });

/** Run fn in idle time (within timeoutMs at the latest), or soon where the browser has no idle callbacks. */
function idleThen(fn: () => void, timeoutMs: number) {
  if ("requestIdleCallback" in window) requestIdleCallback(() => fn(), { timeout: timeoutMs });
  else setTimeout(fn, 0);
}

/**
 * `onTripLine`: a trip that waited for GPS was planned on a late fix (or the ride chip was tapped); Val says this.
 */
export async function create(host: HTMLElement, base: string, onTripLine?: (line: string) => void): Promise<MapImpl> {
  installOnce();
  const abs = new URL(base, location.href).href;

  // The whole archive once, as a Blob: the app's asset loader cannot answer HTTP Range requests.
  const tilesBlob = fetchOk(abs + TILES).then((r) => r.blob());
  const placesP = fetchOk(abs + "derived/pois.json")
    .then((r) => r.json() as Promise<PoiDoc>)
    .then((doc) => new PlaceIndex(doc)); // empty: filled in idle slices (indexPlaces)
  // Search degrades on its own; the map needs its tiles.
  placesP.catch(() => undefined);

  // The footpath graph: fetched and decoded on the first walking route, not while the map is being made.
  let graphP: Promise<{ g: WalkGraph; grid: SnapGrid; router: Router }> | null = null;
  function graph() {
    graphP ??= fetchOk(abs + "derived/walk.graph")
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const t0 = performance.now();
        const g = decodeGraph(buf);
        const out = { g, grid: new SnapGrid(g), router: new Router(g) };
        console.log(`charm:map walk graph ready in ${Math.round(performance.now() - t0)} ms`);
        return out;
      });
    graphP.catch(() => (graphP = null)); // a later route tries again (routing falls back to the arrow meanwhile)
    return graphP;
  }

  // The tram/bus timetable: decoded in idle time once the map has drawn (for the stop dots), or at once on the first
  // trip, whichever is first. Missing files are not an error: walking still works and the card says there is no
  // timetable.
  let transitP: Promise<Network | null> | null = null;
  let wakeTransit: (() => void) | null = null; // a trip question ends the idle wait of a background decode
  function transit(background = false): Promise<Network | null> {
    if (!background) wakeTransit?.();
    transitP ??= Promise.all([
      fetchOk(abs + "derived/transit.bin").then((r) => r.arrayBuffer()),
      fetchOk(abs + "derived/transit-stops.json").then((r) => r.json() as Promise<unknown>),
    ]).then(
      async ([bin, names]) => {
        if (background) await new Promise<void>((r) => ((wakeTransit = r), idleThen(r, 3000)));
        wakeTransit = null;
        const t0 = performance.now();
        const net = transitApi.load(bin, names);
        console.log(`charm:map transit loaded ${net.stopCount} stops in ${Math.round(performance.now() - t0)} ms`);
        return net;
      },
      (err) => {
        console.log(`charm:map transit unavailable: ${err}`);
        transitP = null; // a later trip tries again
        return null;
      },
    );
    return transitP;
  }

  const blob = await tilesBlob;
  const protocol = new Protocol();
  protocol.add(new PMTiles(new FileSource(new File([blob], TILES))));
  maplibregl.addProtocol("pmtiles", protocol.tile);

  const mapEl = document.createElement("div");
  mapEl.className = "cm-map";
  const hud = document.createElement("div");
  hud.className = "cm-hud";
  hud.innerHTML = `
    <label class="cm-search"><span class="cm-tag">Find ▸</span><input class="cm-q" type="search" enterkeyhint="search" placeholder="a place in Dresden" autocomplete="off" spellcheck="false"></label>
    <div class="cm-status" role="status"><span class="cm-tag"><i>●</i> GPS</span><b></b></div>
    <ul class="cm-results"></ul>
    <div class="cm-card"><div class="cm-row"><div class="cm-txt"><button class="cm-guess" aria-label="Did you mean this place? Tap to search"><span class="cm-tag">Did you mean?</span><span></span></button><b></b><em></em><small></small><p class="cm-legs"></p></div>${ARROW_SVG}<button class="cm-next" aria-label="Next journey"></button></div><ol class="cm-deps"></ol><div class="cm-modes"><button data-mode="walk">Walk ▸</button><button data-mode="transit">Tram/Bus ▸</button></div></div>
    <button class="cm-locate idle" aria-label="Where am I">◎</button>
    <button class="cm-attr" aria-label="Map and timetable credits" aria-expanded="false">${ATTR_SHORT}</button>`;
  host.append(mapEl, hud);
  const $ = <T extends Element>(sel: string) => hud.querySelector(sel) as T;
  const input = $<HTMLInputElement>(".cm-q");
  const list = $<HTMLUListElement>(".cm-results");
  const status = $<HTMLDivElement>(".cm-status");
  const statusTag = status.querySelector(".cm-tag")!.lastChild as Text;
  const statusText = status.querySelector("b")!;
  const card = $<HTMLDivElement>(".cm-card");
  const arrow = $<SVGElement>(".cm-arrow");
  const locate = $<HTMLButtonElement>(".cm-locate");
  const legsEl = $<HTMLParagraphElement>(".cm-legs");
  const depsEl = $<HTMLOListElement>(".cm-deps");
  const nextBtn = $<HTMLButtonElement>(".cm-next");
  const walkBtn = $<HTMLButtonElement>('.cm-modes [data-mode="walk"]');
  const transitBtn = $<HTMLButtonElement>('.cm-modes [data-mode="transit"]');
  const attr = $<HTMLButtonElement>(".cm-attr");
  const guessEl = $<HTMLButtonElement>(".cm-guess");
  // A tap on "did you mean?" opens the search with the guess selected, so typing replaces it.
  guessEl.addEventListener("click", () => {
    input.focus();
    input.select();
  });
  let attrTimer = 0;
  /** The credit opens to the full licence text, and folds back after a while (or on a second tap). */
  function openAttr(on: boolean) {
    clearTimeout(attrTimer);
    attr.classList.toggle("open", on);
    attr.setAttribute("aria-expanded", String(on));
    attr.textContent = on ? ATTR_FULL : ATTR_SHORT;
    if (on) attrTimer = window.setTimeout(() => openAttr(false), 6000);
  }
  attr.addEventListener("click", () => openAttr(!attr.classList.contains("open")));

  const map = new maplibregl.Map({
    container: mapEl,
    style: charmStyle(abs, `pmtiles://${TILES}`) as maplibregl.StyleSpecification,
    center: [ALTSTADT.lon, ALTSTADT.lat],
    zoom: 15,
    minZoom: 11,
    maxZoom: 18.5,
    maxBounds: BOUNDS,
    pixelRatio: pixelRatio(), // capped: see device.ts
    trackResize: false, // fitCanvas() resizes only when the displayed size really changed
    attributionControl: false, // our own one-line credit (.cm-attr): a tap shows the full licence text
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    renderWorldCopies: false,
    fadeDuration: 0, // labels appear in place instead of cross-fading on every collision pass
    maxTileCacheSize: 80,
    canvasContextAttributes: { antialias: false, powerPreference: "default" },
  });
  map.touchZoomRotate.disableRotation();
  // A basemap icon missing from the shipped sprite draws nothing instead of warning on every tile.
  map.on("styleimagemissing", (e: { id: string }) => {
    if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });

  const meEl = document.createElement("div");
  meEl.className = "cm-me";
  meEl.innerHTML = "<s></s><u></u><i></i>";
  const me = new maplibregl.Marker({ element: meEl, anchor: "center" });
  let meOnMap = false;
  const xEl = document.createElement("div");
  xEl.className = "cm-x";
  const dest = new maplibregl.Marker({ element: xEl, anchor: "center" });

  let fix: Fix | null = null;
  let follow = true;
  let target: Result | null = null;
  let lastRoute: { lat: number; lon: number; at: number } | null = null;
  let styleReady = false;
  let gpsOff = false; // the app said the location provider is switched off; cleared by the next fix
  let sky: Sky | null = null;
  let skyAt = 0;
  /** How we go to the target: the walking route, or by tram/bus. */
  let travel: "walk" | "transit" = "walk";
  /** The journeys to the target by tram/bus (best first) and the one shown. */
  let trip: { journeys: Journey[]; i: number; from: LatLon; to: Result; daysLeft: number } | null = null;
  /** Walking won over the ride: the card's hint says so, and the ride chip names the ride ("BUS 161 ▸"). */
  let walkWins: { hint: string; chip: string } | null = null;
  /** A tram/bus plan is waiting for the first fix. */
  let tripWaiting: { mode: string } | null = null;
  let boards: maplibregl.Marker[] = [];
  let tripSeq = 0; // a newer plan or a walk drops an older plan's result
  /** The app was unsure: the next target takes these heard words, and its card asks "did you mean?". */
  let pendingGuess: string | null = null;
  let guessHeard: string | null = null;

  const ready = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 6000);
    map.once("load", () => {
      styleReady = true;
      map.addSource("acc", { type: "geojson", data: empty() });
      map.addSource("route", { type: "geojson", data: empty() });
      map.addLayer({ id: "acc-fill", type: "fill", source: "acc", paint: { "fill-color": "#ffb000", "fill-opacity": 0.06 } });
      map.addLayer({
        id: "route-halo",
        type: "line",
        source: "route",
        filter: ["==", ["get", "kind"], "walk"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#000", "line-opacity": 0.7, "line-width": 12 },
      });
      map.addLayer({
        id: "route",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffb3c8",
          "line-width": 6,
          "line-dasharray": [0, 2], // zero-length dashes + round caps = dots
          "line-opacity": ["case", ["==", ["get", "kind"], "walk"], 1, 0.6],
        },
      });
      // Trams and buses: the journey (rides solid in the line colour, walks dotted pink) and the stop dots from z15.
      map.addSource("trip", { type: "geojson", data: empty() });
      map.addSource("stops", { type: "geojson", data: empty() });
      map.addLayer({
        id: "stops-dot",
        type: "circle",
        source: "stops",
        minzoom: 15,
        paint: { "circle-radius": 3.5, "circle-color": "#f4ead5", "circle-stroke-color": "#000", "circle-stroke-width": 1.5 },
      });
      map.addLayer({
        id: "trip-ride-halo",
        type: "line",
        source: "trip",
        filter: ["==", ["get", "kind"], "ride"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#000", "line-opacity": 0.8, "line-width": 10 },
      });
      map.addLayer({
        id: "trip-ride",
        type: "line",
        source: "trip",
        filter: ["==", ["get", "kind"], "ride"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 5 },
      });
      map.addLayer({
        id: "trip-walk",
        type: "line",
        source: "trip",
        filter: ["==", ["get", "kind"], "walk"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffb3c8", "line-width": 6, "line-dasharray": [0, 2] },
      });
      if (fix) applyFix();
      if (target) {
        map.setFilter("pois", poiFilter(target.name) as maplibregl.FilterSpecification);
        if (travel === "walk") void drawRoute(true);
        else if (trip) drawTrip(true);
      }
      map.once("idle", () => {
        clearTimeout(t);
        resolve();
        idleThen(() => void transit(true).then((net) => net && drawStops(net)), 2000); // not during the first render
      });
    });
  });

  map.on("dragstart", () => (follow = false));

  // The place index fills in idle slices once the map has drawn; a search before then hurries the rest (still in
  // slices, one per task), so neither the open nor a voice "take me to …" pays for it in one long stall.
  let indexing: Promise<void> | null = null;
  let hurry = false;
  let slice: ((deadline?: IdleDeadline) => void) | null = null;
  function indexPlaces(places: PlaceIndex): Promise<void> {
    indexing ??= new Promise<void>((resolve) => {
      const t0 = performance.now();
      let slices = 0;
      slice = (deadline?: IdleDeadline) => {
        if (places.complete) return resolve();
        slices++;
        let done: boolean;
        if (deadline && !hurry) {
          done = places.addChunk(IDLE_CHUNK); // at least one step, even when the idle timeout fired
          while (!done && deadline.timeRemaining() > IDLE_MARGIN_MS) done = places.addChunk(IDLE_CHUNK);
        } else {
          done = places.addChunk(HURRY_CHUNK);
        }
        if (!done) return next();
        console.log(`charm:map places indexed ${places.size} in ${slices} slices over ${Math.round(performance.now() - t0)} ms`);
        resolve();
      };
      const run = (deadline?: IdleDeadline) => slice?.(deadline);
      const next = () => void (hurry || !("requestIdleCallback" in window) ? setTimeout(run, 0) : requestIdleCallback(run, { timeout: 1000 }));
      next();
    });
    return indexing;
  }
  void ready.then(() => placesP).then(indexPlaces, () => undefined);

  /** The locate button rides just above the card when the card is up. */
  function placeLocate() {
    const up = card.classList.contains("on");
    locate.style.transform = up ? `translateY(${-(card.offsetHeight + 8)}px)` : "";
    // index.html docks the voice card above this card (and the locate button) while a journey is shown.
    document.body.style.setProperty("--map-card-h", `${up ? card.offsetHeight : 0}px`);
  }

  /** The bottom card: place name, distance and time (amber), and one dim hint line. */
  function setCard(
    title: string,
    metric: string,
    hint: string,
    arrowDeg: number | null,
    more: { legs?: string; next?: string | null; deps?: ReturnType<typeof departureRows>; modes?: boolean } = {},
  ) {
    card.querySelector("b")!.textContent = title;
    const asking = !!guessHeard && !!target;
    card.classList.toggle("guess", asking);
    guessEl.lastChild!.textContent = asking ? `“${guessHeard}”` : "";
    card.querySelector("em")!.textContent = metric;
    card.querySelector("small")!.textContent = hint;
    legsEl.textContent = more.legs ?? "";
    nextBtn.textContent = more.next ? `${more.next} ▸` : "";
    card.classList.toggle("many", !!more.next);
    depsEl.textContent = "";
    for (const d of more.deps ?? []) {
      const li = document.createElement("li");
      const tag = document.createElement("span");
      tag.className = "t";
      tag.textContent = d.tag;
      tag.style.borderColor = d.color;
      const hs = document.createElement("span");
      hs.className = "h";
      hs.textContent = d.headsign;
      const w = document.createElement("span");
      w.className = "w";
      w.textContent = d.when;
      li.append(tag, hs, w);
      depsEl.appendChild(li);
    }
    // Walk / Tram-Bus under a destination's card (not under a stop's departures or "nothing found").
    card.classList.toggle("modes", more.modes ?? target !== null);
    walkBtn.classList.toggle("on", travel === "walk");
    transitBtn.classList.toggle("on", travel === "transit");
    transitBtn.textContent = walkWins && travel === "walk" ? walkWins.chip : "Tram/Bus ▸";
    card.classList.toggle("arrow", arrowDeg !== null);
    if (arrowDeg !== null) arrow.style.transform = `rotate(${arrowDeg}deg)`;
    showCard(true);
  }

  const showText = (t: CardText, modes?: boolean) => setCard(t.title, t.metric, t.hint, null, { legs: t.legs, next: t.next, modes });

  function showCard(on: boolean) {
    card.classList.toggle("on", on);
    placeLocate();
  }

  const fixFresh = () => !!fix && performance.now() - fix.at < FIX_STALE_MS;

  function updateStatus() {
    const fresh = fixFresh();
    status.classList.toggle("off", fresh && !gpsOff);
    status.classList.toggle("gps-off", gpsOff);
    statusTag.textContent = gpsOff ? " GPS OFF" : " GPS";
    statusText.textContent = gpsStatusText(gpsOff, !!fix, performance.now() - skyAt < SKY_STALE_MS ? sky : null);
    meEl.classList.toggle("stale", !!fix && !fresh);
    locate.classList.toggle("idle", !fix);
  }
  setInterval(updateStatus, 5000); // lives as long as the page; the check is cheap
  updateStatus();

  function applyFix() {
    if (!fix) return;
    me.setLngLat([fix.lon, fix.lat]);
    if (!meOnMap) {
      me.addTo(map);
      meOnMap = true;
    }
    const heading = fix.heading;
    meEl.classList.toggle("heading", heading !== undefined);
    if (heading !== undefined) (meEl.firstElementChild as HTMLElement).style.transform = `rotate(${heading}deg)`;
    if (styleReady) {
      (map.getSource("acc") as maplibregl.GeoJSONSource).setData(circle(fix.lat, fix.lon, Math.max(fix.acc, 3)));
    }
    updateStatus();
  }

  /**
   * Room the route needs around it: below the search bar (and the GPS strip while it shows), above the card and the
   * locate button riding on it. Measured, so the safe-area insets and a two-line card are counted.
   */
  function fitPadding() {
    // Layout boxes (offsetTop ignores the card's slide-in transform), in the HUD's frame, which covers the map.
    const h = hud.clientHeight;
    const stripUp = !status.classList.contains("off") && !hud.classList.contains("searching");
    const above = stripUp ? status : $<HTMLElement>(".cm-search");
    const top = above.offsetTop + above.offsetHeight + 24;
    const cardTop = card.classList.contains("on") ? card.offsetTop : h - 32 - 90;
    const bottom = Math.max(0, h - cardTop) + 8 + 48 + 16;
    // A frame too small for these paddings would make fitBounds give up: keep at least a third of it for the route.
    const room = h - top - bottom;
    const squeeze = room < h / 3 ? (h / 3 - room) / 2 : 0;
    return { top: Math.max(8, top - squeeze), bottom: Math.max(8, bottom - squeeze), left: 48, right: 48 };
  }

  /** Fits the map to these points plus where you are (a fresh fix) and the target, so neither ends at the edge. */
  function fitTo(pts: [number, number][], maxZoom: number) {
    const all = pts.slice();
    if (fix && fixFresh()) all.push([fix.lon, fix.lat]);
    if (target) all.push([target.lon, target.lat]);
    if (!all.length) return;
    const bounds = new maplibregl.LngLatBounds(all[0], all[0]);
    for (const p of all) bounds.extend(p);
    map.fitBounds(bounds, { padding: fitPadding(), maxZoom, duration: reduced() ? 0 : 600 });
  }

  async function drawRoute(fit: boolean) {
    if (!target) return;
    console.log(`charm:map walk route ${fix ? "from the fix" : "waits for a fix"}${fit ? " (fit)" : ""}`);
    if (!fix) {
      setCard(target.name, "", gpsOff ? "Turn on location for a route" : "Route starts once GPS finds you", null);
      return;
    }
    const straight = haversine(fix.lat, fix.lon, target.lat, target.lon);
    lastRoute = { lat: fix.lat, lon: fix.lon, at: performance.now() };
    if (straight < ARRIVED_M) {
      setCard(target.name, target.category === "home" ? "You're home!" : "You're there!", "", null);
      setRoute(null);
      return;
    }
    let path: [number, number][] | null = null;
    try {
      const { g, grid, router } = await graph();
      const a = grid.nearest(fix.lat, fix.lon, SNAP_M);
      const b = grid.nearest(target.lat, target.lon, SNAP_M);
      const r = a >= 0 && b >= 0 ? router.route(a, b) : null;
      if (r) path = trimHooks(pathCoords(g, r.nodes, fix, target));
    } catch {
      path = null; // no graph data: fall through to the arrow
    }
    if (path) {
      const meters = pathLength(path);
      setRoute(path, "walk");
      setCard(target.name, `${formatDistance(meters)} · ${formatWalk(meters)}`, walkWins?.hint ?? "Follow the pink dots", null);
    } else {
      setRoute([[fix.lon, fix.lat], [target.lon, target.lat]], "straight");
      setCard(target.name, formatDistance(straight), "That way · no path on my map", bearing(fix.lat, fix.lon, target.lat, target.lon));
    }
    if (fit) fitTo(path ?? [[fix.lon, fix.lat], [target.lon, target.lat]], 17);
  }

  function setRoute(coords: [number, number][] | null, kind = "walk") {
    if (!styleReady) return;
    (map.getSource("route") as maplibregl.GeoJSONSource).setData(
      coords
        ? { type: "Feature", properties: { kind }, geometry: { type: "LineString", coordinates: coords } }
        : empty(),
    );
  }

  async function search(query: string): Promise<Result[]> {
    try {
      const places = await placesP;
      if (!places.complete) {
        if (!hurry && slice) setTimeout(() => slice?.(), 0); // don't wait for the pending idle slice
        hurry = true;
        await indexPlaces(places);
      }
      return places.search(query, fix ?? ALTSTADT);
    } catch {
      return [];
    }
  }

  // ---- Trams and buses ----

  function clearTrip() {
    trip = null;
    tripWaiting = null;
    document.body.classList.remove("map-trip");
    for (const m of boards) m.remove();
    boards = [];
    if (styleReady) (map.getSource("trip") as maplibregl.GeoJSONSource).setData(empty());
  }

  /** The shown journey on the map (lines, boarding labels) and on the card. */
  function drawTrip(fit: boolean) {
    if (!trip) return;
    const j = trip.journeys[trip.i];
    document.body.classList.add("map-trip"); // index.html docks the voice card above the journey's card
    showText(journeyCard(j, trip.i, trip.journeys.length, trip.to.name, transitApi.clock, trip.daysLeft));
    if (!styleReady) return; // the load handler draws it
    const lines = journeyLines(j, trip.from, trip.to);
    // Labels point inwards: a stop east of the journey's middle gets its label on its left, so none runs off screen.
    const lons = lines.features.flatMap((f) => f.geometry.coordinates.map((c) => c[0]));
    const midLon = (Math.min(...lons) + Math.max(...lons)) / 2;
    (map.getSource("trip") as maplibregl.GeoJSONSource).setData(lines);
    for (const m of boards) m.remove();
    boards = j.legs
      .filter((l): l is RideLeg => !l.walk)
      .map((leg) => {
        const el = document.createElement("div");
        el.className = "cm-board";
        el.textContent = boardLabel(leg, transitApi.clock);
        el.style.borderColor = lineColor(leg.color, leg.mode);
        const east = leg.fromStop.lon > midLon;
        return new maplibregl.Marker({ element: el, anchor: east ? "bottom-right" : "bottom-left", offset: [east ? -6 : 6, -6] })
          .setLngLat([leg.fromStop.lon, leg.fromStop.lat])
          .addTo(map);
      });
    if (fit) fitTo(lines.features.flatMap((f) => f.geometry.coordinates as [number, number][]), 16.5);
  }

  /** The target is shown as the destination (pin, name in the search bar), whichever way we go. */
  function markTarget(r: Result) {
    target = r;
    guessHeard = pendingGuess; // a guess belongs to this target only; the next one (a tap, a search) clears it
    pendingGuess = null;
    showResults(null);
    input.value = r.name;
    input.blur();
    xEl.innerHTML = r.category === "home" ? HOME_SVG : X_SVG; // re-inserting restarts the pop animation
    dest.setLngLat([r.lon, r.lat]).addTo(map);
    follow = false;
    if (styleReady) map.setFilter("pois", poiFilter(r.name) as maplibregl.FilterSpecification);
  }

  const usableFix = () => (fix && performance.now() - fix.at <= OLD_FIX_MS ? { lat: fix.lat, lon: fix.lon } : null);

  /**
   * Plans to r by tram/bus and shows it; resolves with Val's line. When walking is quicker, shows the walk and keeps
   * the ride on its chip; `rideOnly` (the chip) shows the ride anyway.
   */
  async function planTransit(r: Result, mode = "any", from?: LatLon, rideOnly = false): Promise<string> {
    const mine = ++tripSeq;
    travel = "transit";
    walkWins = null;
    clearTrip();
    setRoute(null);
    markTarget(r);
    const net = await transit();
    if (mine !== tripSeq) return "";
    const origin = from ?? usableFix();
    const t0 = performance.now();
    const now = new Date();
    const p = planTrip(net, transitApi, r, mode, origin, now, gpsOff, rideOnly);
    console.log(`charm:map transit ${p.kind}${p.kind === "trip" ? ` ${p.journeys.length} journeys` : ""} in ${Math.round(performance.now() - t0)} ms`);
    if (p.kind === "trip") {
      trip = { journeys: p.journeys, i: 0, from: origin!, to: r, daysLeft: net!.daysLeft(now) };
      drawTrip(true);
      return p.line;
    }
    if (p.kind === "walk") {
      travel = "walk";
      walkWins = { hint: p.journeys ? "Quicker than tram or bus" : "Close enough to walk", chip: rideChip(p.journeys?.[0]) };
      lastRoute = null;
      if (styleReady) await drawRoute(true);
      else setCard(r.name, `Walk · about ${p.minutes} min`, walkWins.hint, null);
      return p.line;
    }
    if (p.kind === "here") {
      travel = "walk";
      setRoute(null);
      showText(p.card, false);
      return p.line;
    }
    if (p.kind === "wait") tripWaiting = { mode };
    showText(p.card);
    if (styleReady) map.easeTo({ center: [r.lon, r.lat], zoom: 15, duration: reduced() ? 0 : 600 });
    return p.line;
  }

  function homeResult(): Result | null {
    const h = loadHome();
    return h ? { id: -100, name: "Home", category: "home", lat: h.lat, lon: h.lon, distance: fix ? haversine(fix.lat, fix.lon, h.lat, h.lon) : 0, score: 0 } : null;
  }

  async function goHome(mode = "any", from?: LatLon): Promise<string> {
    const h = homeResult();
    if (h) return planTransit(h, mode, from);
    showResults(null);
    input.blur();
    setCard("No home yet", "", "Say “this is my home” when you're there", null, { modes: false });
    return LINES.noHome;
  }

  /** Every stop as a small dot from z15 (tap one for its departures). */
  function drawStops(net: Network) {
    if (!styleReady) return;
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
    for (let i = 0; i < net.stopCount; i++) {
      const s = net.stop(i);
      features.push({ type: "Feature", properties: { i }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } });
    }
    (map.getSource("stops") as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features });
  }

  /** A stop's next departures on the card; resolves with Val's line. */
  function showStop(net: Network, i: number, mode = "any"): string {
    const s = net.stop(i);
    const now = new Date();
    const all = net.nextDepartures(i, now, 8);
    const picked = all ? filterMode(all, mode) : null;
    const deps = picked ? picked.deps.slice(0, 4) : null;
    const name = transitApi.stopName(s.name);
    console.log(`charm:map stop departures (${deps === null ? "expired" : deps.length} rows${picked?.missing ? `, no ${picked.missing}` : ""})`);
    // The stop is what the map shows now: no old destination, route or journey, and its name in the search bar.
    tripSeq++;
    target = null;
    guessHeard = null;
    dest.remove();
    clearTrip();
    setRoute(null);
    showResults(null);
    input.value = name;
    const metric = deps === null ? "Timetable expired" : !deps.length ? "Nothing leaving soon" : picked?.missing ? `No ${picked.missing} soon` : "Next departures";
    const note = timetableNote(net.daysLeft(now));
    setCard(name, metric, note.charAt(0).toUpperCase() + note.slice(1), null, { deps: deps ? departureRows(deps, transitApi.clock) : [], modes: false });
    return transitApi.describeDepartures(s.name, deps ? deps.slice(0, 3) : null, picked?.missing);
  }

  // A tap near a stop dot (a 44 px box, the dots are small) shows its departures.
  map.on("click", (e: maplibregl.MapMouseEvent) => {
    if (!styleReady || !transitP) return;
    const { x, y } = e.point;
    const hits = map.queryRenderedFeatures([[x - 22, y - 22], [x + 22, y + 22]], { layers: ["stops-dot"] });
    if (!hits.length) return;
    const d2 = (f: maplibregl.MapGeoJSONFeature) => {
      const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
      const p = map.project([lon, lat]);
      return (p.x - x) ** 2 + (p.y - y) ** 2;
    };
    const best = hits.reduce((a, b) => (d2(b) < d2(a) ? b : a));
    const i = Number(best.properties?.i);
    console.log("charm:map stop dot tapped");
    void transitP.then((net) => {
      if (!net || !Number.isInteger(i) || i < 0 || i >= net.stopCount) return;
      showStop(net, i);
    });
  });

  walkBtn.addEventListener("click", () => {
    if (target) void routeTo(target);
  });
  transitBtn.addEventListener("click", () => {
    if (!target) return;
    const offered = walkWins !== null; // the ride chip under "quicker to walk": show that ride, and say it
    void planTransit(target, "any", undefined, true).then((line) => offered && line && onTripLine?.(line));
  });
  nextBtn.addEventListener("click", () => {
    if (!trip || trip.journeys.length < 2) return;
    trip.i = (trip.i + 1) % trip.journeys.length;
    drawTrip(true);
  });

  async function routeTo(r: Result) {
    console.log(`charm:map walk to a result (${r.category})`);
    tripSeq++;
    travel = "walk";
    walkWins = null;
    clearTrip();
    markTarget(r);
    if (!styleReady) return; // the load handler draws it
    if (!fix) map.easeTo({ center: [r.lon, r.lat], zoom: 16, duration: reduced() ? 0 : 600 });
    await drawRoute(true);
  }

  function row(name: string, meta: string, dist: string) {
    const li = document.createElement("li");
    const text = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = name;
    const small = document.createElement("small");
    small.textContent = meta;
    text.append(b, small);
    const em = document.createElement("em");
    em.textContent = dist;
    li.append(text, em);
    return li;
  }

  /**
   * Up to four results with their distance; null hides the list; [] says nothing matched. `home`: the empty search's
   * HOME ▸ row first (by tram/bus to the saved home).
   */
  function showResults(results: Result[] | null, home = false) {
    list.textContent = "";
    if (home) {
      const saved = loadHome() !== null;
      const li = document.createElement("li");
      li.className = "cm-homerow";
      const tag = document.createElement("span");
      tag.className = "cm-tag";
      tag.textContent = "Home ▸";
      const text = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = saved ? "Tram or bus home" : "No home saved yet";
      const small = document.createElement("small");
      small.textContent = saved ? "From where you are" : "Say “this is my home”";
      text.append(b, small);
      li.append(text, tag); // the text lines up with the place rows; the tag sits where their distance does
      li.addEventListener("click", () => void goHome());
      list.appendChild(li);
    }
    if (results && results.length === 0) {
      const li = document.createElement("li");
      li.className = "cm-empty";
      li.textContent = "Nothing called that nearby";
      list.appendChild(li);
    }
    for (const r of results?.slice(0, MAX_RESULTS) ?? []) {
      // Without a fix the distance is from the Altstadt, not from you: the category alone says enough.
      const li = row(r.name, CATEGORY_LABEL[r.category] ?? r.category, fix ? formatDistance(r.distance) : "");
      li.addEventListener("click", () => void routeTo(r));
      list.appendChild(li);
    }
    list.classList.toggle("on", !!results);
    hud.classList.toggle("searching", !!results);
    document.body.classList.toggle("map-searching", !!results); // index.html hides the voice card over the list
  }

  /** The preset sights, nearest first once there is a fix (otherwise in their fixed order). */
  function presets(): Result[] {
    const all = PRESETS.map(([name, lat, lon], i) => ({
      id: -1 - i,
      name,
      category: "sight",
      lat,
      lon,
      distance: fix ? haversine(fix.lat, fix.lon, lat, lon) : 0,
      score: 0,
    }));
    return fix ? all.sort((a, b) => a.distance - b.distance) : all;
  }

  let debounce = 0;
  let seq = 0; // drops answers to older keystrokes
  function runSearch() {
    const q = input.value.trim();
    const mine = ++seq;
    if (!q) return document.activeElement === input ? showResults(presets(), true) : showResults(null);
    void search(q).then((r) => mine === seq && showResults(r));
  }
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = window.setTimeout(runSearch, 60);
  });
  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const results = await search(input.value);
    if (results[0]) void routeTo(results[0]);
    else showResults([]);
  });
  input.addEventListener("focus", () => {
    showCard(false);
    if (!input.value.trim()) showResults(presets(), true);
    else if (!target) runSearch();
  });
  input.addEventListener("blur", () => {
    // A tap on a result arrives after the blur: let it land before the list goes.
    setTimeout(() => {
      if (document.activeElement === input) return;
      showResults(null);
      if (target) {
        input.value = target.name;
        showCard(true);
      }
    }, 200);
  });
  locate.addEventListener("click", () => {
    follow = true;
    if (fix) map.easeTo({ center: [fix.lon, fix.lat], zoom: Math.max(map.getZoom(), 16), duration: reduced() ? 0 : 500 });
  });

  /**
   * Resize the map only when its element is displayed and its size differs from the canvas: a resize re-allocates
   * the drawing buffer and redraws (~100 ms on the phone). A hidden element (0×0) never resizes, so the canvas never
   * falls back to MapLibre's 400×300.
   */
  function fitCanvas() {
    const w = mapEl.clientWidth;
    const h = mapEl.clientHeight;
    if (w === 0 || h === 0) return;
    const c = map.getCanvas();
    if (parseFloat(c.style.width) === w && parseFloat(c.style.height) === h) return;
    map.resize();
  }
  // The window changes size when the keyboard comes up for the search (and on rotation): follow it while shown.
  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    if (resizeFrame || mapEl.style.display === "none") return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      fitCanvas();
    });
  });

  return {
    ready,
    show() {
      mapEl.style.display = hud.style.display = "";
      fitCanvas();
    },
    hide() {
      mapEl.style.display = hud.style.display = "none"; // also stops the pulsing ring from painting
      input.blur();
      document.body.classList.remove("map-searching", "map-trip");
    },
    setGpsOff() {
      gpsOff = true;
      updateStatus();
      if (target && !fix && travel === "walk") void drawRoute(false);
      if (target && tripWaiting) setCard(target.name, "", "Turn on location for a trip", null);
    },
    setSky(s) {
      sky = s;
      skyAt = performance.now();
      updateStatus();
    },
    setFix(f) {
      const first = !fix;
      fix = f;
      gpsOff = false;
      applyFix();
      if (first && !target) map.jumpTo({ center: [f.lon, f.lat], zoom: 16 });
      else if (follow && !target) map.easeTo({ center: [f.lon, f.lat], duration: 400 });
      if (target && tripWaiting && f.acc <= 100 && performance.now() - f.at < FRESH_FIX_MS) {
        // The trip waited for this fix: plan it now, and Val says the new line.
        void planTransit(target, tripWaiting.mode).then((line) => line && onTripLine?.(line));
      }
      if (target && travel === "walk" && (!lastRoute || (performance.now() - lastRoute.at > REROUTE_MS && haversine(lastRoute.lat, lastRoute.lon, f.lat, f.lon) > REROUTE_M))) {
        void drawRoute(!lastRoute);
      }
    },
    search,
    routeTo,
    guess(heard) {
      pendingGuess = heard;
    },
    async goTo(place) {
      const results = await search(place);
      if (results[0]) return routeTo(results[0]);
      pendingGuess = guessHeard = null; // nothing to guess at: the card says so
      await ready;
      input.value = place;
      setCard(`Nothing called “${place}” nearby`, "", "Try another name", null, { modes: false });
    },
    async transitTo(place, mode, from) {
      if (place === "home") return goHome(mode, from);
      const results = await search(place);
      if (results[0]) return planTransit(results[0], mode, from);
      const net = await transit(); // not on the map's place list: maybe a stop name
      const i = net ? net.findStop(place) : -1;
      if (net && i >= 0) {
        const s = net.stop(i);
        const name = transitApi.stopName(s.name);
        return planTransit({ id: -200 - i, name, category: "station", lat: s.lat, lon: s.lon, distance: 0, score: 0 }, mode, from);
      }
      pendingGuess = guessHeard = null; // nothing to guess at: the card says so
      await ready;
      input.value = place;
      setCard(`Nothing called “${place}” nearby`, "", "Try another name", null, { modes: false });
      return `I couldn't find ${place} on my map.`;
    },
    async departures(stop, mode) {
      const net = await transit();
      if (!net) return LINES.noTimetable;
      const near = usableFix(); // "from here" only from a fix up to OLD_FIX_MS old
      const want = modeOfWord(mode); // "next tram": a stop trams serve
      const i = stop ? net.findStop(stop, want) : near ? net.nearestStop(near.lat, near.lon, undefined, want) : -1;
      if (i < 0) return stop ? `I don't know a stop called ${stop}.` : LINES.whichStop;
      const s = net.stop(i);
      if (styleReady) map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 16), duration: reduced() ? 0 : 600 });
      return showStop(net, i, mode);
    },
    reset() {
      tripSeq++; // an older plan still running drops its result
      target = null;
      pendingGuess = guessHeard = null;
      travel = "walk";
      walkWins = null;
      lastRoute = null;
      dest.remove();
      clearTrip();
      setRoute(null);
      clearTimeout(debounce);
      seq++;
      input.value = "";
      input.blur();
      showResults(null);
      showCard(false);
      openAttr(false);
      follow = true;
      if (styleReady) map.setFilter("pois", poiFilter() as maplibregl.FilterSpecification);
      const at = fix ? { lon: fix.lon, lat: fix.lat } : ALTSTADT;
      map.jumpTo({ center: [at.lon, at.lat], zoom: fix ? 16 : 15 });
    },
    findingYou(place) {
      // A new destination is coming: the old one's pin, route, name and "did you mean?" go now, not after the fix.
      tripSeq++;
      clearTrip();
      walkWins = null;
      target = null;
      pendingGuess = guessHeard = null;
      dest.remove();
      setRoute(null);
      const title = place === "home" ? "Home" : place.replace(/(^|\s)\p{Ll}/gu, (c) => c.toUpperCase());
      input.value = title;
      showResults(null);
      setCard(title, "Finding you…", gpsOff ? "Turn on location for a trip" : "The trip starts once GPS finds you", null, { modes: false });
    },
  };
}

function reduced() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function pathCoords(g: WalkGraph, nodes: number[], from: { lat: number; lon: number }, to: { lat: number; lon: number }) {
  const out: [number, number][] = [[from.lon, from.lat]];
  for (const i of nodes) out.push([g.lon[i], g.lat[i]]);
  out.push([to.lon, to.lat]);
  return out;
}
