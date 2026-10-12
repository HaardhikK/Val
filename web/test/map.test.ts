import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { bearing, formatDistance, formatWalk, haversine, pathLength, trimHooks } from "../src/map/geo";
import { MinHeap, Router, SnapGrid, decodeGraph, graphFrom } from "../src/map/graph";
import { PlaceIndex, type PoiDoc } from "../src/map/search";
import { FONTS, LANDMARKS, charmStyle, poiFilter } from "../src/map/style";

test("haversine: Frauenkirche to Hauptbahnhof is about 1.4 km", () => {
  const d = haversine(51.0519, 13.7416, 51.0404, 13.7317);
  assert.ok(Math.abs(d - 1446) < 20, `got ${d}`);
  assert.equal(haversine(51, 13, 51, 13), 0);
});

test("haversine: one degree of latitude is about 111.2 km", () => {
  assert.ok(Math.abs(haversine(50, 13, 51, 13) - 111_195) < 50);
});

test("bearing points north, east, south and west", () => {
  assert.ok(Math.abs(bearing(51, 13, 51.01, 13) - 0) < 0.01);
  assert.ok(Math.abs(bearing(51, 13, 51, 13.01) - 90) < 0.1);
  assert.ok(Math.abs(bearing(51.01, 13, 51, 13) - 180) < 0.01);
  assert.ok(Math.abs(bearing(51, 13.01, 51, 13) - 270) < 0.1);
});

test("distances read like a person would say them", () => {
  assert.equal(formatDistance(3), "10 m");
  assert.equal(formatDistance(347), "350 m");
  assert.equal(formatDistance(1234), "1.2 km");
  assert.equal(formatDistance(15_400), "15 km");
  assert.equal(formatWalk(480), "6 min walk");
  assert.equal(formatWalk(15_600), "3 h 15 min walk");
});

test("the heap pops in priority order", () => {
  const h = new MinHeap();
  const values = Array.from({ length: 3000 }, (_, i) => (i * 7919) % 3001);
  values.forEach((p, i) => h.push(p, i));
  let last = -Infinity;
  while (h.size) {
    const v = h.pop();
    assert.ok(values[v] >= last);
    last = values[v];
  }
});

// A 3x3 street grid (about 110 m blocks) plus a long detour: 0-1-2 / 3-4-5 / 6-7-8, and an island 9-10.
const step = 0.001;
const pts: [number, number][] = [];
for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) pts.push([51 + r * step, 13 + c * step * 1.6]);
pts.push([51.05, 13.05], [51.0501, 13.0501]);
const edges: [number, number][] = [
  [0, 1], [1, 2], [3, 4], [4, 5], [6, 7], [7, 8], // rows
  [0, 3], [3, 6], [2, 5], [5, 8], // outer columns only: the middle column is missing
  [9, 10],
];
const grid = graphFrom(pts, edges);

test("A* finds the shortest walk on a small street grid", () => {
  const r = new Router(grid).route(1, 7);
  assert.ok(r);
  // 1 → 0 → 3 → 6 → 7 or the mirror via 2-5-8: both are 4 segments; never through the missing middle column.
  assert.equal(r.nodes.length, 5);
  assert.equal(r.nodes[0], 1);
  assert.equal(r.nodes[4], 7);
  assert.ok(!r.nodes.includes(4));
  const direct = haversine(pts[1][0], pts[1][1], pts[7][0], pts[7][1]);
  assert.ok(r.meters > direct * 1.5 && r.meters < direct * 2.5, `${r.meters} vs ${direct}`);
});

test("A* returns the start for a zero-length trip and null for unreachable or invalid nodes", () => {
  const router = new Router(grid);
  assert.deepEqual(router.route(4, 4)?.nodes, [4]);
  assert.equal(router.route(0, 9), null);
  assert.equal(router.route(-1, 3), null);
  assert.equal(router.route(0, 99), null);
  // Buffers are reused between searches: a later query is unaffected by an earlier one.
  assert.deepEqual(router.route(3, 5)?.nodes, [3, 4, 5]);
});

test("snapping finds the nearest node, and nothing beyond the limit", () => {
  const snap = new SnapGrid(grid, 50);
  assert.equal(snap.nearest(51.0011, 13.0016), 4);
  assert.equal(snap.nearest(51.00001, 13.00001), 0);
  assert.equal(snap.nearest(51.0502, 13.0502), 10);
  assert.equal(snap.nearest(51.02, 13.02, 400), -1); // 2+ km from every node
});

test("decodeGraph reads the builder's binary format", () => {
  // Two nodes at the box corners, one footpath (two directed entries).
  const n = 2, m = 2;
  const buf = new ArrayBuffer(32 + 4 * n + 4 * (n + 1) + 4 * m);
  const dv = new DataView(buf);
  [0x43, 0x57, 0x47, 0x31].forEach((b, i) => dv.setUint8(i, b));
  dv.setUint32(4, n, true);
  dv.setUint32(8, m, true);
  [50.96, 13.57, 51.18, 13.97].forEach((v, i) => dv.setFloat32(12 + 4 * i, v, true));
  new Uint16Array(buf, 32, 4).set([0, 0, 65535, 65535]);
  new Uint32Array(buf, 40, 3).set([0, 1, 2]);
  new Uint32Array(buf, 52, 2).set([1, 0]);
  const g = decodeGraph(buf);
  assert.equal(g.n, 2);
  assert.ok(Math.abs(g.lat[1] - 51.18) < 1e-5 && Math.abs(g.lon[0] - 13.57) < 1e-5);
  assert.deepEqual(new Router(g).route(0, 1)?.nodes, [0, 1]);
  assert.throws(() => decodeGraph(buf.slice(0, 40)));
  assert.throws(() => decodeGraph(new ArrayBuffer(64)));
});

const doc: PoiDoc = {
  v: 1,
  cats: ["station", "sight", "pharmacy", "toilets", "building", "street"],
  pois: [
    ["Frauenkirche", 1, 51.05193, 13.74165],
    ["Frauenkirche / Altmarkt", 0, 51.04996, 13.74158],
    ["Hauptbahnhof", 0, 51.04086, 13.73328],
    ["Apotheke am Altmarkt", 2, 51.0505, 13.7375],
    ["Löwen-Apotheke Neustadt", 2, 51.0660, 13.7500],
    ["Sanifair-WC", 3, 51.0408, 13.7330],
    ["Toilets", 3, 51.0515, 13.7410],
    ["Pfunds Molkerei", 4, 51.06283, 13.75358],
    ["Prager Straße", 5, 51.0455, 13.7360],
  ],
};
const places = new PlaceIndex(doc);
const altmarkt = { lat: 51.0505, lon: 13.7373 };
const names = (q: string) => places.search(q, altmarkt).map((r) => r.name);

test("search: the index fills in chunks, and a search before it is full still finds everything", () => {
  const idx = new PlaceIndex(doc);
  assert.equal(idx.complete, false); // nothing indexed at construction (no main-thread stall at map start)
  assert.equal(idx.addChunk(1), false);
  assert.equal(idx.search("Hauptbahnhof", altmarkt)[0]?.name, "Hauptbahnhof"); // not in the first chunk: finishes the rest first
  assert.equal(idx.complete, true);
  assert.equal(idx.addChunk(1000), true);
});

test("search: an exact name comes first, and typos still find it", () => {
  assert.equal(names("Frauenkirche")[0], "Frauenkirche");
  assert.equal(names("frauenkirsche")[0], "Frauenkirche");
  assert.equal(names("Hauptbahn")[0], "Hauptbahnhof"); // prefix
});

test("search: synonyms work both ways (pharmacy ↔ Apotheke, station ↔ Bahnhof, toilet ↔ WC)", () => {
  assert.equal(names("pharmacy")[0], "Apotheke am Altmarkt");
  assert.equal(names("Apotheke")[0], "Apotheke am Altmarkt");
  assert.ok(names("main station").includes("Hauptbahnhof"));
  assert.ok(names("Bahnhof").includes("Hauptbahnhof"));
  assert.ok(names("toilet").includes("Sanifair-WC"));
});

test("search: a kind of place ranks by distance, not by its name", () => {
  // "WC" is in Sanifair's name, but the unnamed toilets are much closer to the Altmarkt.
  assert.equal(names("WC")[0], "Toilets");
  assert.equal(names("nearest toilet")[0], "Toilets");
  // From the Neustadt the Neustadt pharmacy is nearest.
  assert.equal(places.search("Apotheke", { lat: 51.066, lon: 13.75 })[0].name, "Löwen-Apotheke Neustadt");
});

test("search: compounds, ß and filler words", () => {
  assert.equal(names("Pfundsmolkerei")[0], "Pfunds Molkerei");
  assert.equal(names("Prager Strasse")[0], "Prager Straße");
  assert.equal(names("take me to the Frauenkirche")[0], "Frauenkirche");
  assert.deepEqual(names("   "), []);
  assert.deepEqual(names("xyzzyq"), []);
});

test("search: a partial word lands on the landmark, not on a place that merely contains it", () => {
  const idx = new PlaceIndex({
    v: 1,
    cats: ["station", "sight", "street", "building"],
    pois: [
      ["Zwei Frauen", 1, 51.0580, 13.7470],
      ["Frauenstraße", 2, 51.0510, 13.7400],
      ["Frauenkirche", 1, 51.05193, 13.74165],
      ["Frauenkirche / Altmarkt", 0, 51.04996, 13.74158],
      ["Postplatz (Zwinger)", 0, 51.0505, 13.7330],
      ["Zwinger", 1, 51.05297, 13.73374],
      ["Semper Zwei", 1, 51.0550, 13.7340],
      ["Gottfried Semper Denkmal", 1, 51.0520, 13.7380],
      ["Semperoper", 1, 51.05427, 13.73551],
    ],
  });
  const first = (q: string) => idx.search(q, altmarkt)[0]?.name;
  assert.equal(first("frauen"), "Frauenkirche");
  assert.equal(first("zwinger"), "Zwinger");
  assert.equal(first("semper"), "Semperoper");
});

test("the map style only asks for glyphs that ship with the app", () => {
  const style = charmStyle("https://appassets.androidplatform.net/assets/charm/map/", "pmtiles://dresden.pmtiles");
  const used = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      if (v.length && v.every((s) => typeof s === "string" && s.startsWith("Noto"))) v.forEach((s) => used.add(s));
      else v.forEach(walk);
    } else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const layer of style.layers) walk((layer as { layout?: unknown }).layout);
  assert.ok(used.size > 0);
  for (const f of used) assert.ok(FONTS.includes(f), `unshipped font ${f}`);
  assert.equal(style.sources.protomaps.attribution, "© OpenStreetMap contributors");
});

test("the map style is trimmed: no casings, solid paths, landmarks only as text", () => {
  const style = charmStyle("https://appassets.androidplatform.net/assets/charm/map/", "pmtiles://dresden.pmtiles");
  const ids = style.layers.map((l) => l.id);
  assert.ok(!ids.some((id) => id.includes("casing")), "casing layers draw black on black");
  assert.ok(!ids.includes("address_label"));
  const foot = style.layers.find((l) => l.id === "roads_other") as { paint: Record<string, unknown> };
  assert.equal(foot.paint["line-dasharray"], undefined, "only the route is dotted");
  const pois = style.layers.find((l) => l.id === "pois") as { layout: Record<string, unknown>; filter: unknown };
  assert.equal(pois.layout["icon-image"], undefined);
  assert.equal(pois.layout["text-size"], 13);
  const kinds = JSON.stringify(pois.filter);
  for (const k of LANDMARKS) assert.ok(kinds.includes(k));
  assert.ok(!/restaurant|cafe|supermarket|fast_food/.test(kinds));
  assert.ok(JSON.stringify(poiFilter("Frauenkirche")).includes('"Frauenkirche"'));
  assert.equal(style.layers.find((l) => l.id === "background")?.type, "background");
});

test("route hooks: an end node past the destination is dropped, a straight path is kept", () => {
  const straight: [number, number][] = [
    [13.73, 51.05],
    [13.731, 51.05],
    [13.732, 51.05],
    [13.733, 51.05],
  ];
  assert.deepEqual(trimHooks(straight), straight);
  // The last graph node lies 70 m beyond the destination: the line would run out and double back.
  const hooked: [number, number][] = [...straight.slice(0, 3), [13.734, 51.05], [13.733, 51.05]];
  const t = trimHooks(hooked);
  assert.deepEqual(t[t.length - 1], [13.733, 51.05]);
  assert.ok(!t.some((p) => p[0] === 13.734));
  // The same at the start: the first node lies behind the walker.
  const behind: [number, number][] = [[13.73, 51.05], [13.729, 51.05], ...straight.slice(1)];
  assert.deepEqual(trimHooks(behind), straight);
  // An ordinary corner is walked, not cut through the block.
  const corner: [number, number][] = [
    [13.73, 51.05],
    [13.7305, 51.05],
    [13.7305, 51.0505],
    [13.7305, 51.051],
    [13.731, 51.051],
  ];
  assert.deepEqual(trimHooks(corner), corner);
  assert.ok(Math.abs(pathLength(straight) - 3 * haversine(51.05, 13.73, 51.05, 13.731)) < 0.5);
});

// Shape checks on the real derived data, when it has been built (scripts/build-map-data.py).
const DERIVED = process.env.CHARM_MAP_DERIVED ?? `${process.env.CHARM_CACHE ?? "../.cache"}/downloads/map/derived`;
const hasData = existsSync(`${DERIVED}/walk.graph`) && existsSync(`${DERIVED}/pois.json`);

test("derived data: graph and places have the expected shape", { skip: !hasData && "map data not built" }, () => {
  const raw = readFileSync(`${DERIVED}/walk.graph`);
  const g = decodeGraph(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  assert.ok(g.n > 1000);
  for (let i = 0; i < g.n; i += 997) {
    assert.ok(g.offsets[i] <= g.offsets[i + 1]);
    for (let k = g.offsets[i]; k < g.offsets[i + 1]; k++) assert.ok(g.targets[k] < g.n);
  }
  const pois = JSON.parse(readFileSync(`${DERIVED}/pois.json`, "utf8")) as PoiDoc;
  assert.equal(pois.v, 1);
  for (const p of pois.pois.slice(0, 500)) {
    assert.equal(typeof p[0], "string");
    assert.ok(p[1] >= 0 && p[1] < pois.cats.length);
    assert.ok(p[2] > 50.9 && p[2] < 51.2 && p[3] > 13.5 && p[3] < 14);
  }
  const idx = new PlaceIndex(pois);
  const fk = idx.search("Frauenkirche")[0];
  assert.equal(idx.search("frauen")[0].name, "Frauenkirche");
  assert.equal(idx.search("zwinger")[0].name, "Zwinger");
  assert.equal(idx.search("semper")[0].name, "Semperoper");
  const snap = new SnapGrid(g);
  const a = snap.nearest(51.0505, 13.7373); // Altmarkt
  const b = snap.nearest(fk.lat, fk.lon);
  const r = new Router(g).route(a, b);
  assert.ok(r && r.meters > 200 && r.meters < 1500, `route ${r?.meters}`);
});
