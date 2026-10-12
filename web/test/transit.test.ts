import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { decodeTransit, type TransitNames } from "../src/transit/decode";
import { TransitRouter, berlinClock, clockText, type RideLeg } from "../src/transit/raptor";
import { describeDepartures, describeJourney, describePlan, MAX_SPOKEN, spokenName } from "../src/transit/describe";
import { transitApi } from "../src/transit/api";
import { planTrip } from "../src/transit/card";
import type { Journey } from "../src/transit/raptor";

// ---- A tiny network in the exact transit.bin layout ----

interface Net {
  baseDate: number;
  stops: [number, number][];
  routes: { line: number; mode: number; stops: number[]; trips: { mask: number; headsign: number; times: number[] }[] }[];
  transfers: [number, number, number][];
}

function encode(net: Net): ArrayBuffer {
  const routeStops = net.routes.flatMap((r) => r.stops);
  const trips = net.routes.flatMap((r) => r.trips);
  const stopTimes = trips.flatMap((t) => t.times);
  const stopRoutes: [number, number][][] = net.stops.map(() => []);
  net.routes.forEach((r, ri) => r.stops.forEach((s, pos) => stopRoutes[s].push([ri, pos])));
  const nPairs = stopRoutes.reduce((a, l) => a + l.length, 0);
  const size =
    30 + 8 * net.stops.length + 15 * net.routes.length + 4 * routeStops.length + 8 * trips.length + 2 * stopTimes.length +
    10 * net.transfers.length + 4 * (net.stops.length + 1) + 6 * nPairs;
  const dv = new DataView(new ArrayBuffer(size));
  let o = 0;
  const u8 = (v: number) => dv.setUint8(o++, v);
  const u16 = (v: number) => (dv.setUint16(o, v, true), (o += 2));
  const u32 = (v: number) => (dv.setUint32(o, v, true), (o += 4));
  const f32 = (v: number) => (dv.setFloat32(o, v, true), (o += 4));
  for (const c of "CHTR") u8(c.charCodeAt(0));
  u16(1);
  u32(net.baseDate);
  [net.stops.length, net.routes.length, trips.length, stopTimes.length, net.transfers.length].forEach(u32);
  for (const [lat, lon] of net.stops) (f32(lat), f32(lon));
  let rs = 0;
  let tr = 0;
  for (const r of net.routes) {
    u16(r.line);
    u8(r.mode);
    u16(r.stops.length);
    u32(rs);
    u32(tr);
    u16(r.trips.length);
    rs += r.stops.length;
    tr += r.trips.length;
  }
  routeStops.forEach(u32);
  let st = 0;
  for (const t of trips) (u16(t.mask), u16(t.headsign), u32(st), (st += t.times.length));
  stopTimes.forEach(u16);
  for (const [a, b, s] of net.transfers) (u32(a), u32(b), u16(s));
  let acc = 0;
  for (const l of stopRoutes) (u32(acc), (acc += l.length));
  u32(acc);
  for (const l of stopRoutes) for (const [r, p] of l) (u32(r), u16(p));
  assert.equal(o, size);
  return dv.buffer;
}

const ALL = 0x3fff;
const NO_DAY1 = ALL & ~(1 << 1);
// A–B–C on tram 1; F (100 m from C) –D–E on bus 62; a slow direct bus 3 from A to E.
const NET: Net = {
  baseDate: 20261011,
  stops: [
    [51.0, 13.7], // 0 A
    [51.01, 13.7], // 1 B
    [51.02, 13.7], // 2 C
    [51.03, 13.7], // 3 D
    [51.04, 13.7], // 4 E
    [51.0209, 13.7], // 5 F
  ],
  routes: [
    {
      line: 0,
      mode: 0,
      stops: [0, 1, 2],
      trips: [
        { mask: ALL, headsign: 0, times: [600, 605, 610] },
        { mask: NO_DAY1, headsign: 0, times: [620, 625, 630] },
        { mask: ALL, headsign: 0, times: [1445, 1450, 1455] }, // 00:05 of the next calendar day
      ],
    },
    {
      line: 1,
      mode: 1,
      stops: [5, 3, 4],
      trips: [
        { mask: ALL, headsign: 1, times: [615, 620, 625] },
        { mask: ALL, headsign: 1, times: [640, 645, 650] },
        { mask: ALL, headsign: 1, times: [1460, 1465, 1470] },
      ],
    },
    { line: 2, mode: 1, stops: [0, 4], trips: [{ mask: ALL, headsign: 1, times: [600, 640] }] },
  ],
  transfers: [
    [2, 5, 120],
    [5, 2, 120],
  ],
};
const NAMES: TransitNames = {
  stops: ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"],
  lines: ["1", "62", "3"],
  headsigns: ["Charlie", "Echo"],
  lineColors: ["#e30613", "#00a0e3", "#7fb041"],
};
const [A, C, E, F] = [NET.stops[0], NET.stops[2], NET.stops[4], NET.stops[5]];

/** A wall-clock time in Berlin in October 2026 (CEST, UTC+2). */
const berlin = (ymd: number, h: number, m: number) =>
  new Date(Date.UTC(Math.floor(ymd / 10000), (Math.floor(ymd / 100) % 100) - 1, ymd % 100, h - 2, m));

const router = () => new TransitRouter(decodeTransit(encode(NET), NAMES));
const rides = (legs: { walk: boolean }[]) => legs.filter((l): l is RideLeg => !l.walk);

test("transit decode round-trips the binary layout", () => {
  const t = decodeTransit(encode(NET), NAMES);
  assert.equal(t.baseDate, 20261011);
  assert.deepEqual([t.nStops, t.nRoutes, t.nTrips], [6, 3, 7]);
  assert.ok(Math.abs(t.stopLat[5] - 51.0209) < 1e-5);
  assert.deepEqual([...t.routeLine], [0, 1, 2]);
  assert.deepEqual([...t.routeMode], [0, 1, 1]);
  assert.deepEqual([...t.routeLen], [3, 3, 2]);
  assert.deepEqual([...t.routeStops], [0, 1, 2, 5, 3, 4, 0, 4]);
  assert.deepEqual([...t.routeTripStart], [0, 3, 6]);
  assert.deepEqual([...t.tripMask], [ALL, NO_DAY1, ALL, ALL, ALL, ALL, ALL]);
  assert.deepEqual([...t.stopTimes.slice(6, 9)], [1445, 1450, 1455]);
  assert.deepEqual([...t.tripTimeStart], [0, 3, 6, 9, 12, 15, 18]);
  // Transfers grouped by "from": C → F and F → C.
  assert.deepEqual([t.transferTo[t.transferStart[2]], t.transferSec[t.transferStart[2]]], [5, 120]);
  assert.deepEqual([t.transferTo[t.transferStart[5]], t.transferSec[t.transferStart[5]]], [2, 120]);
  // Stop A is on route 0 at 0 and route 2 at 0.
  const a = [t.stopRouteStart[0], t.stopRouteStart[1]];
  assert.deepEqual([...t.stopRouteRoute.slice(a[0], a[1])], [0, 2]);
});

test("transit decode refuses a truncated or foreign file", () => {
  const buf = encode(NET);
  assert.throws(() => decodeTransit(buf.slice(0, buf.byteLength - 1), NAMES), /wrong size|truncated/);
  const bad = buf.slice(0);
  new DataView(bad).setUint8(0, 0x58);
  assert.throws(() => decodeTransit(bad, NAMES), /not a timetable/);
  assert.throws(() => decodeTransit(buf, { ...NAMES, stops: ["x"] }), /names/);
});

test("berlin clock reads local time in summer time", () => {
  assert.deepEqual(berlinClock(berlin(20261011, 22, 14)), { ymd: 20261011, seconds: 22 * 3600 + 14 * 60 });
  assert.equal(clockText(berlin(20261012, 0, 5)), "00:05");
});

test("one change beats the slow direct bus; both are offered", () => {
  const res = router().plan(berlin(20261011, 9, 58), A[0], A[1], E[0], E[1]);
  assert.ok(res.journeys, res.reason);
  assert.equal(res.journeys.length, 2);
  const [best, slow] = res.journeys;
  assert.equal(best.transfers, 1);
  assert.deepEqual(rides(best.legs).map((l) => [l.line, l.fromStop.name, l.toStop.name, clockText(l.depart), clockText(l.arrive), l.stops]), [
    ["1", "Alpha", "Charlie", "10:00", "10:10", 2],
    ["62", "Foxtrot", "Echo", "10:15", "10:25", 2],
  ]);
  // The footpath C → F; the zero-length walks at the ends are no legs.
  assert.equal(best.legs.length, 3);
  const walk = best.legs[1];
  assert.ok(walk.walk && walk.fromStop?.name === "Charlie" && walk.toStop?.name === "Foxtrot" && walk.minutes === 2);
  assert.equal(clockText(best.arrive), "10:25");
  assert.equal(rides(best.legs)[0].path.length, 3);
  assert.equal(slow.transfers, 0);
  assert.equal(clockText(rides(slow.legs)[0].arrive), "10:40");
});

test("the day mask drops a trip on its excluded day", () => {
  const r = router();
  const today = r.plan(berlin(20261011, 10, 1), A[0], A[1], C[0], C[1]);
  assert.equal(clockText(rides(today.journeys![0].legs)[0].depart), "10:20");
  const monday = r.plan(berlin(20261012, 10, 1), A[0], A[1], C[0], C[1]);
  // 10:20 does not run on day 1, so the next one is the night tram at 00:05.
  const ride = rides(monday.journeys![0].legs)[0];
  assert.equal(clockText(ride.depart), "00:05");
  assert.equal(berlinClock(ride.depart).ymd, 20261013);
});

test("after midnight, yesterday's late trips are used", () => {
  const res = router().plan(berlin(20261012, 0, 1), A[0], A[1], E[0], E[1]);
  assert.ok(res.journeys, res.reason);
  const legs = rides(res.journeys[0].legs);
  assert.deepEqual(legs.map((l) => [l.line, clockText(l.depart), clockText(l.arrive)]), [
    ["1", "00:05", "00:15"],
    ["62", "00:20", "00:30"],
  ]);
  assert.equal(berlinClock(legs[1].arrive).ymd, 20261012);
});

test("outside the 14-day window the timetable has expired", () => {
  const r = router();
  for (const when of [berlin(20261025, 10, 0), berlin(20261010, 10, 0)]) {
    const res = r.plan(when, A[0], A[1], E[0], E[1]);
    assert.equal(res.journeys, null);
    assert.equal(res.reason, "timetable expired");
    assert.equal(r.nextDepartures(0, when, 3), null);
  }
  assert.ok(r.plan(berlin(20261024, 9, 0), A[0], A[1], E[0], E[1]).journeys);
});

test("no stop within reach, and no connection, say so", () => {
  const r = router();
  const far = r.plan(berlin(20261011, 9, 0), 51.5, 13.7, E[0], E[1]);
  assert.equal(far.reason, "no stops nearby");
  const late = r.plan(berlin(20261011, 23, 0), E[0], E[1], A[0], A[1]); // nothing runs E → A
  assert.equal(late.reason, "no connection");
  assert.ok(late.walkMinutes > 50);
});

test("next departures, soonest first, including yesterday's night trips", () => {
  const r = router();
  const deps = r.nextDepartures(0, berlin(20261011, 9, 58), 3)!;
  assert.deepEqual(deps.map((d) => [d.line, clockText(d.depart), d.inMinutes]), [
    ["1", "10:00", 2],
    ["3", "10:00", 2],
    ["1", "10:20", 22],
  ]);
  assert.deepEqual(r.nextDepartures(4, berlin(20261011, 9, 58), 3), []); // a terminus: nothing leaves
  const night = r.nextDepartures(0, berlin(20261012, 0, 1), 1)!;
  assert.equal(clockText(night[0].depart), "00:05");
});

test("Val describes the journey from the planner's values, with the live note once", () => {
  const r = router();
  const session = { liveNoteGiven: false };
  const res = r.plan(berlin(20261011, 9, 58), A[0], A[1], E[0], E[1]);
  assert.equal(
    describeJourney(res.journeys![0], session),
    "Take tram 1 from Alpha at 10:00 towards Charlie, walk 2 minutes, change at Foxtrot to bus 62 at 10:15, get off at Echo. " +
      "You'll be there at 10:25 (timetable, not live).",
  );
  assert.ok(!describeJourney(res.journeys![1], session).includes("not live"));
  assert.match(describePlan({ journeys: null, reason: "timetable expired", walkMinutes: 9 }, session), /expired/);
  assert.match(describePlan({ journeys: null, reason: "no connection", walkMinutes: 9 }, session), /9 minutes/);
  const deps = r.nextDepartures(0, berlin(20261011, 9, 58), 1);
  assert.equal(describeDepartures("Alpha", deps, { liveNoteGiven: true }), "Next from Alpha: tram 1 towards Charlie at 10:00, in 2 minutes.");
});

test("headsigns and stops as Val says them", () => {
  assert.equal(spokenName("Bf. Mitte"), "Mitte station");
  assert.equal(spokenName("Btf. Trachenberge"), "Trachenberge depot");
  assert.equal(spokenName("Coschütz ü. Bf. Mitte"), "Coschütz via Mitte station");
  assert.equal(spokenName("Reick ü. Hauptbahnhof"), "Reick via Hauptbahnhof");
  assert.equal(spokenName("Löbtau -> Li.6"), "Löbtau");
  assert.equal(spokenName("Altnossener Str."), "Altnossener Straße");
  assert.equal(spokenName("Hellerhofstr."), "Hellerhofstraße");
  assert.equal(spokenName("Kleinzsch."), "Kleinzschachwitz");
  assert.equal(spokenName("Klotzsche, K.-Kollwitz-Pl."), "Klotzsche, K.-Kollwitz-Platz");
  assert.equal(spokenName("Dresden Hbf (Strehlener Str.)"), "Hauptbahnhof");
  assert.equal(spokenName("MESSE DRESDEN"), "Messe");
  assert.equal(spokenName("Weißig Wanderw. z. Rauenstein"), "Weißig Wanderweg zum Rauenstein");
  assert.equal(spokenName("A.-Wolf-Platz"), "A.-Wolf-Platz");
  assert.equal(spokenName("Dresden Postplatz"), "Postplatz");
});

const stopRef = (index: number, name: string) => ({ index, name, lat: 51, lon: 13.7 });
const at10 = (m: number) => berlin(20261011, 10, m);
function leg(line: string, from: string, to: string, dep: number, headsign: string): RideLeg {
  return { walk: false, line, mode: 0, color: "", headsign, fromStop: stopRef(1, from), toStop: stopRef(2, to), depart: at10(dep), arrive: at10(dep + 5), stops: 3, path: [] };
}

test("speech names where to board and where to get off, without stop counts, and skips a loop's headsign", () => {
  const j: Journey = {
    legs: [{ walk: true, toStop: stopRef(1, "Dresden Postplatz"), minutes: 4 }, leg("1", "Dresden Postplatz", "Dresden Altmarkt", 14, "Bf. Mitte"), { walk: true, fromStop: stopRef(2, "Altmarkt"), minutes: 3 }],
    leave: at10(10), arrive: at10(22), rides: 1, transfers: 0,
  };
  const line = describeJourney(j, { liveNoteGiven: true });
  assert.equal(line, "Walk 4 minutes, take tram 1 from Postplatz at 10:14 towards Mitte station, get off at Altmarkt, then walk 3 minutes. You'll be there at 10:22.");
  assert.ok(!/stops?\b/.test(line));
  const loop = { ...j, legs: [leg("61", "Löbtau", "Altmarkt", 14, "Löbtau -> Li.6")] };
  assert.equal(describeJourney(loop, { liveNoteGiven: true }), "Take tram 61 from Löbtau at 10:14, get off at Altmarkt. You'll be there at 10:22.");
});

test("a long journey is summarised under the spoken limit", () => {
  const j: Journey = {
    legs: [
      { walk: true, minutes: 6 },
      leg("7", "Dresden Pennrich Gleisschleife", "Dresden Hauptbahnhof Nord", 5, "Btf. Trachenberge"),
      { walk: true, fromStop: stopRef(2, "a"), toStop: stopRef(3, "b"), minutes: 3 },
      leg("66", "Dresden Hauptbahnhof", "Dresden Lockwitz", 20, "Kleinzsch."),
      leg("88", "Dresden Lockwitz", "Dresden Kleinzschachwitz Fähre", 40, "Coschütz ü. Bf. Mitte"),
      { walk: true, fromStop: stopRef(4, "c"), minutes: 5 },
    ],
    leave: at10(0), arrive: at10(55), rides: 3, transfers: 2,
  };
  const line = describeJourney(j, { liveNoteGiven: false });
  assert.ok(line.length <= MAX_SPOKEN, `${line.length}: ${line}`);
  assert.match(line, /^Walk 6 minutes, take tram 7 from Pennrich Gleisschleife at 10:05.*then 2 more changes, then walk 5 minutes\. You'll be there at 10:55 \(timetable, not live\)\.$/);
});

test("no tram soon: Val names what leaves instead", () => {
  const r = router();
  const deps = r.nextDepartures(0, berlin(20261011, 9, 58), 2)!.filter((d) => d.mode === 1);
  assert.equal(describeDepartures("Alpha", deps, { liveNoteGiven: true }, "tram"), "No tram soon from Alpha; the next is bus 3 towards Echo at 10:00, in 2 minutes.");
});

test("a stop the asked mode serves wins, by name and by distance", () => {
  const r = router();
  // Alpha (tram 1 and bus 3) and Foxtrot (bus 62 only), 2.3 km apart; Charlie (tram terminus) 100 m from Foxtrot.
  assert.equal(r.serves(0, 0), true);
  assert.equal(r.serves(2, 0), false); // a terminus: nothing departs
  assert.equal(r.nearestStop(F[0], F[1], 600, 0), 5); // no tram departs nearby: the nearest stop of any kind
  assert.equal(r.nearestStop(F[0], F[1], 600, 1), 5);
  assert.equal(r.findStop("a", 1), 0); // "Alpha" contains a and serves buses
});

test("a change at the same stop takes at least 90 s", () => {
  // Tram 1 reaches C at 10:10; a bus from C at 10:11 is too tight, the one at 10:12 is fine.
  const net: Net = {
    baseDate: 20261011,
    stops: [[51.0, 13.7], [51.02, 13.7], [51.04, 13.7]],
    routes: [
      { line: 0, mode: 0, stops: [0, 1], trips: [{ mask: ALL, headsign: 0, times: [600, 610] }] },
      { line: 1, mode: 1, stops: [1, 2], trips: [{ mask: ALL, headsign: 1, times: [611, 620] }, { mask: ALL, headsign: 1, times: [612, 625] }] },
    ],
    transfers: [],
  };
  const names: TransitNames = { stops: ["Alpha", "Charlie", "Echo"], lines: ["1", "62"], headsigns: ["Charlie", "Echo"], lineColors: ["", ""] };
  const r = new TransitRouter(decodeTransit(encode(net), names));
  const res = r.plan(berlin(20261011, 9, 58), 51.0, 13.7, 51.04, 13.7);
  const legs = rides(res.journeys![0].legs);
  assert.deepEqual(legs.map((l) => clockText(l.depart)), ["10:00", "10:12"]);
});

// ---- The real pack, when it has been built (scripts/build-transit.py, read-only here) ----

const DERIVED = process.env.CHARM_MAP_DERIVED ?? `${process.env.CHARM_CACHE ?? "../.cache"}/downloads/map/derived`;
/** The YYYYMMDD date k days after ymd (the real pack's window starts at its baseDate, so its dates follow the build). */
const addDays = (ymd: number, k: number) => {
  const d = new Date(Date.UTC(Math.floor(ymd / 10000), (Math.floor(ymd / 100) % 100) - 1, (ymd % 100) + k));
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};
const hasTransit = existsSync(`${DERIVED}/transit.bin`) && existsSync(`${DERIVED}/transit-stops.json`);

test("real timetable: line 1 from Postplatz and query speed", { skip: !hasTransit && "transit data not built" }, () => {
  const raw = readFileSync(`${DERIVED}/transit.bin`);
  const names = JSON.parse(readFileSync(`${DERIVED}/transit-stops.json`, "utf8")) as TransitNames;
  const t0 = performance.now();
  const net = decodeTransit(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), names);
  const r = new TransitRouter(net);
  const loadMs = performance.now() - t0;
  assert.ok(net.baseDate > 20200101, `baseDate ${net.baseDate}`);
  const today = addDays(net.baseDate, 1); // built from yesterday by default, so the window covers today and 13 more days
  const post = r.findStop("Postplatz");
  assert.ok(post >= 0);
  const noon = berlin(today, 12, 0);
  const deps = r.nextDepartures(post, noon, 500)!.filter((d) => d.line === "1");
  const hbfTram = r.findStop("Hauptbahnhof", 0);
  assert.ok(hbfTram >= 0 && r.serves(hbfTram, 0), `tram stop for Hauptbahnhof: ${net.names.stops[hbfTram]}`);
  // Line 1 runs all day: the next 3 leave within the hour, in order (the exact times depend on the day you build).
  assert.ok(deps.length >= 3, `${deps.length} line-1 departures`);
  const first3 = deps.slice(0, 3).map((d) => d.depart.getTime());
  assert.ok(first3.every((t, i) => t >= noon.getTime() && t <= noon.getTime() + 3600_000 && (i === 0 || t >= first3[i - 1])),
    deps.slice(0, 3).map((d) => clockText(d.depart)).join(", "));

  // Random stop pairs across the city at varied times of day.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const runs = 200;
  let found = 0;
  let worst = 0;
  const start = performance.now();
  for (let i = 0; i < runs; i++) {
    const a = Math.floor(rnd() * net.nStops);
    const b = Math.floor(rnd() * net.nStops);
    const q0 = performance.now();
    const res = r.plan(berlin(addDays(net.baseDate, 3), 6 + Math.floor(rnd() * 16), 0), net.stopLat[a], net.stopLon[a], net.stopLat[b], net.stopLon[b]);
    worst = Math.max(worst, performance.now() - q0);
    if (res.journeys) found++;
  }
  const avg = (performance.now() - start) / runs;
  console.log(`real timetable: load ${loadMs.toFixed(0)} ms, plan avg ${avg.toFixed(2)} ms, worst ${worst.toFixed(1)} ms, ${found}/${runs} found`);
  assert.ok(found > runs * 0.8, `${found}/${runs} found`);
  assert.ok(avg < 100);

  // Walking vs riding, and changes, over many random pairs (stops, nudged up to ~300 m) at varied times.
  const api = transitApi.load(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), names);
  const fake = { describeJourney: () => "", describePlan: () => "" };
  let planned = 0;
  let slowerRaw = 0;
  let slowerChosen = 0;
  let walks = 0;
  let tightChanges = 0;
  let longest = 0;
  let longestLine = "";
  for (let i = 0; i < 800; i++) {
    const a = Math.floor(rnd() * net.nStops);
    const from = { lat: net.stopLat[a] + (rnd() - 0.5) * 0.005, lon: net.stopLon[a] + (rnd() - 0.5) * 0.008 };
    // Every other pair is a short hop (up to ~2.5 km), where walking often wins; the rest are city-wide.
    const b = Math.floor(rnd() * net.nStops);
    const near = i % 2 === 0;
    const to = near
      ? { lat: from.lat + (rnd() - 0.5) * 0.04, lon: from.lon + (rnd() - 0.5) * 0.06, name: "x" }
      : { lat: net.stopLat[b] + (rnd() - 0.5) * 0.005, lon: net.stopLon[b] + (rnd() - 0.5) * 0.008, name: "x" };
    const when = berlin(addDays(net.baseDate, 2 + Math.floor(rnd() * 3)), 5 + Math.floor(rnd() * 19), Math.floor(rnd() * 60));
    const res = api.plan(when, from, to);
    if (!res.journeys) continue;
    planned++;
    const walkArrives = when.getTime() + res.walkMinutes * 60_000;
    if (res.journeys[0].arrive.getTime() > walkArrives) slowerRaw++;
    const p = planTrip(api, fake, to, "any", from, when);
    if (p.kind === "walk") walks++;
    if (p.kind === "trip" && p.journeys[0].arrive.getTime() > walkArrives) slowerChosen++;
    for (const j of res.journeys) {
      const rl = rides(j.legs);
      for (let k = 1; k < rl.length; k++) {
        if (rl[k].fromStop.index === rl[k - 1].toStop.index && rl[k].depart.getTime() - rl[k - 1].arrive.getTime() < 90_000) tightChanges++;
      }
      const said = describeJourney(j, { liveNoteGiven: false });
      if (said.length > longest) [longest, longestLine] = [said.length, said];
    }
  }
  console.log(`real timetable: ${planned} planned, ${slowerRaw} best rides slower than walking, ${slowerChosen} chosen, ${walks} walks, ${tightChanges} changes < 90 s, longest line ${longest}: ${longestLine}`);
  assert.ok(planned > 300);
  assert.equal(slowerChosen, 0, "no chosen ride arrives later than walking");
  assert.equal(tightChanges, 0, "no change at the same stop under 90 s");
  assert.ok(longest <= MAX_SPOKEN, `longest spoken line ${longest}`);

  const session = { liveNoteGiven: false };
  const hbf = r.findStop("Hauptbahnhof");
  const res = r.plan(berlin(today, 22, 0), net.stopLat[post], net.stopLon[post], net.stopLat[hbf], net.stopLon[hbf]);
  console.log(`real timetable: ${describePlan(res, session)}`);
});
