import { test } from "node:test";
import assert from "node:assert/strict";
import type { Departure, Journey, Network, PlanResult, RideLeg, StopRef } from "../src/transit/api";
import {
  boardLabel,
  departureRows,
  filterMode,
  journeyCard,
  journeyLines,
  legList,
  lineColor,
  noJourneyCard,
  planTrip,
  preferMode,
  rideChip,
  timetableNote,
  WALK_ONLY_M,
} from "../src/transit/card";
import { FRESH_FIX_MS, GOOD_FIX_M, HOME_KEY, LINES, Locator, OLD_FIX_MS, fixTime, loadHome, saveHome } from "../src/transit/trip";
import { respond, type Command, type Notes } from "../src/assistant";
import { featureStep, homeState, type FeatureState } from "../src/features";

const clock = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
const at = (hhmm: string) => new Date(`2026-10-11T${hhmm}:00Z`);
const stop = (index: number, name: string, lat: number, lon: number): StopRef => ({ index, name, lat, lon });
const POSTPLATZ = stop(1, "Dresden Postplatz", 51.0505, 13.7335);
const ALBERT = stop(2, "Dresden Albertplatz", 51.0632, 13.7476);
const BAHNHOF = stop(3, "Dresden Bahnhof Neustadt", 51.0657, 13.7406);

function ride(line: string, mode: 0 | 1, from: StopRef, to: StopRef, dep: string, arr: string, stops: number, color = "#e2001a"): RideLeg {
  return { walk: false, line, mode, color, headsign: "Somewhere", fromStop: from, toStop: to, depart: at(dep), arrive: at(arr), stops, path: [[from.lon, from.lat], [to.lon, to.lat]] };
}

const tramTrip: Journey = {
  legs: [{ walk: true, toStop: POSTPLATZ, minutes: 4 }, ride("1", 0, POSTPLATZ, ALBERT, "22:14", "22:22", 6), { walk: true, fromStop: ALBERT, minutes: 3 }],
  leave: at("22:10"),
  arrive: at("22:25"),
  rides: 1,
  transfers: 0,
};
const changeTrip: Journey = {
  legs: [
    { walk: true, toStop: POSTPLATZ, minutes: 4 },
    ride("62", 1, POSTPLATZ, ALBERT, "22:12", "22:18", 4, "#00a0e0"),
    { walk: true, fromStop: ALBERT, toStop: BAHNHOF, minutes: 2 },
    ride("3", 0, BAHNHOF, ALBERT, "22:24", "22:28", 2, "bad"),
  ],
  leave: at("22:08"),
  arrive: at("22:30"),
  rides: 2,
  transfers: 1,
};

test("the card shows the departure in amber, the arrival, the changes and the legs", () => {
  const c = journeyCard(tramTrip, 0, 3, "Home", clock);
  assert.equal(c.title, "Home");
  assert.equal(c.metric, "TRAM 1 · dep 22:14");
  assert.equal(c.hint, "Arr 22:25 · direct · not live");
  assert.equal(c.legs.replace(/\u00a0/g, " "), "walk 4 min → tram 1 → 6 stops → walk 3 min");
  assert.ok(!c.legs.split(" → ").some((step) => step.includes(" ")), "each step keeps its words together");
  assert.equal(c.next, "1/3");
  const d = journeyCard(changeTrip, 1, 2, "Zoo", clock);
  assert.equal(d.metric, "BUS 62 · dep 22:12");
  assert.equal(d.hint, "Arr 22:30 · 1 change · not live");
  assert.equal(journeyCard(changeTrip, 0, 1, "Zoo", clock, 3).hint, "Arr 22:30 · 1 change · ends in 3 days");
  assert.equal(d.legs.replace(/\u00a0/g, " "), "walk 4 min → bus 62 → 4 stops → walk 2 min → tram 3 → 2 stops");
  assert.equal(d.next, "2/2");
  assert.equal(journeyCard(tramTrip, 0, 1, "Home", clock).next, null); // one journey: no next chip
  const walkOnly: Journey = { legs: [{ walk: true, minutes: 7 }], leave: at("09:00"), arrive: at("09:07"), rides: 0, transfers: 0 };
  assert.equal(journeyCard(walkOnly, 0, 1, "X", clock).metric, "Walk · leave 09:00");
  assert.equal(legList({ ...tramTrip, legs: [ride("8", 0, POSTPLATZ, ALBERT, "10:00", "10:02", 1)] }), "tram\u00a08 → 1\u00a0stop");
});

test("boarding labels and line colours", () => {
  assert.equal(boardLabel(tramTrip.legs[1] as RideLeg, clock), "TRAM 1 · 22:14");
  assert.equal(boardLabel(changeTrip.legs[1] as RideLeg, clock), "BUS 62 · 22:12");
  assert.equal(lineColor("#00A0E0", 1), "#00a0e0");
  assert.equal(lineColor("red;line-width:9", 0), "#e2001a"); // only a plain hex colour reaches the style
  assert.equal(lineColor(undefined, 1), "#8ab4ff");
  assert.equal(lineColor("#123", 9), "#c9a0ff");
});

test("the journey's lines: walks pink from the origin and to the destination, rides in the line colour", () => {
  const from = { lat: 51.04, lon: 13.72 };
  const to = { lat: 51.07, lon: 13.75 };
  const fc = journeyLines(changeTrip, from, to);
  assert.deepEqual(fc.features.map((f) => f.properties!.kind), ["walk", "ride", "walk", "ride"]);
  assert.deepEqual(fc.features[0].geometry.coordinates, [[from.lon, from.lat], [POSTPLATZ.lon, POSTPLATZ.lat]]);
  assert.deepEqual(fc.features[2].geometry.coordinates, [[ALBERT.lon, ALBERT.lat], [BAHNHOF.lon, BAHNHOF.lat]]);
  assert.equal(fc.features[1].properties!.color, "#00a0e0");
  assert.equal(fc.features[3].properties!.color, "#e2001a"); // "bad" → the tram colour
  const last = journeyLines(tramTrip, from, to).features[2];
  assert.deepEqual(last.geometry.coordinates, [[ALBERT.lon, ALBERT.lat], [to.lon, to.lat]]);
});

test("a wanted mode puts its journeys first, or says none fits", () => {
  assert.deepEqual(preferMode([changeTrip, tramTrip], "tram"), { journeys: [tramTrip, changeTrip], matched: true });
  assert.deepEqual(preferMode([tramTrip, changeTrip], "bus"), { journeys: [tramTrip, changeTrip], matched: false });
  assert.deepEqual(preferMode([changeTrip], "any"), { journeys: [changeTrip], matched: true });
});

const dep = (line: string, mode: 0 | 1, inMinutes: number, color = "#e2001a"): Departure => ({ line, mode, color, headsign: `To ${line}`, depart: at("12:00"), inMinutes });

test("a stop's departures: line, headsign, minutes from now", () => {
  const rows = departureRows([dep("1", 0, 0), dep("62", 1, 4, "#00a0e0"), dep("2", 0, 12), dep("9", 0, 75)], clock);
  assert.deepEqual(rows[0], { tag: "TRAM 1", headsign: "To 1", when: "now", color: "#e2001a" });
  assert.deepEqual(rows[1], { tag: "BUS 62", headsign: "To 62", when: "4 min", color: "#00a0e0" });
  assert.equal(rows[3].when, "12:00"); // an hour or more away: the clock time
  assert.equal(departureRows([dep("1", 0, 1), dep("2", 0, 2), dep("3", 0, 3), dep("4", 0, 4), dep("5", 0, 5)], clock).length, 4);
  assert.deepEqual(filterMode([dep("1", 0, 1), dep("62", 1, 2)], "bus").deps.map((d) => d.line), ["62"]);
  const noBus = filterMode([dep("1", 0, 1)], "bus"); // none of that mode: all of them, and Val says so
  assert.deepEqual([noBus.deps.map((d) => d.line), noBus.missing], [["1"], "bus"]);
  assert.equal(filterMode([dep("1", 0, 1)], "any").missing, undefined);
  assert.deepEqual(filterMode([], "tram"), { deps: [] });
});

test("the timetable note and the ride chip", () => {
  assert.equal(timetableNote(), "timetable, not live");
  assert.equal(timetableNote(5), "timetable, not live");
  assert.equal(timetableNote(4), "timetable ends in 4 days");
  assert.equal(timetableNote(1), "timetable ends today");
  assert.equal(timetableNote(9, true), "not live");
  assert.equal(timetableNote(2, true), "ends in 2 days");
  assert.equal(rideChip(changeTrip), "BUS 62 ▸");
  assert.equal(rideChip(undefined), "Tram/Bus ▸");
});

test("no journey: the card says why and offers the walk", () => {
  const none = (reason: PlanResult["reason"]): PlanResult => ({ journeys: null, reason, walkMinutes: 25 });
  assert.equal(noJourneyCard(none("timetable expired"), "Zoo").metric, "Timetable expired");
  assert.equal(noJourneyCard(none("no stops nearby"), "Zoo").metric, "No stop close enough");
  assert.equal(noJourneyCard(none("no connection"), "Zoo").hint, "On foot about 25 min");
});

// ---- The trip flow against a fake router ----

function fakeNet(result: PlanResult): Network & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    stopCount: 3,
    stop: (i) => [POSTPLATZ, ALBERT, BAHNHOF][i - 1],
    findStop: () => -1,
    nearestStop: () => -1,
    plan: (when, from, to) => {
      asked.push({ when, from, to });
      return result;
    },
    nextDepartures: () => [],
    daysLeft: () => 14,
  };
}
const fakeApi = { describeJourney: (j: Journey) => `ride ${j.legs.length} legs`, describePlan: (r: PlanResult) => `no: ${r.reason}` };
const zoo = { name: "Zoo", lat: 51.03, lon: 13.75 };
const here = { lat: 51.05, lon: 13.74 };

test("the trip flow: no timetable, waiting for GPS, no route, a journey", () => {
  const none = planTrip(null, fakeApi, zoo, "any", here, at("22:00"));
  assert.equal(none.kind, "none");
  assert.equal(none.line, LINES.noTimetable);
  if (none.kind === "none") assert.equal(none.card.metric, "No timetable yet");

  const net = fakeNet({ journeys: [changeTrip, tramTrip], walkMinutes: 30 });
  const wait = planTrip(net, fakeApi, zoo, "any", null, at("22:00"));
  assert.equal(wait.kind, "wait");
  assert.equal(wait.line, LINES.noFix);
  assert.equal(planTrip(net, fakeApi, zoo, "any", null, at("22:00"), true).line, LINES.gpsOff);
  assert.equal(net.asked.length, 0); // nothing planned without a start

  const ok = planTrip(net, fakeApi, zoo, "tram", here, at("22:00"));
  assert.equal(ok.kind, "trip");
  if (ok.kind === "trip") assert.deepEqual(ok.journeys, [tramTrip, changeTrip]);
  assert.equal(ok.line, "ride 3 legs");
  assert.deepEqual(net.asked[0], { when: at("22:00"), from: here, to: zoo });

  const busOnly = planTrip(fakeNet({ journeys: [tramTrip], walkMinutes: 30 }), fakeApi, zoo, "bus", here, at("22:00"));
  assert.match(busOnly.line, /^There's no bus all the way, but here's a trip\. ride 3 legs$/);

  const noRoute = planTrip(fakeNet({ journeys: null, reason: "no connection", walkMinutes: 9 }), fakeApi, zoo, "any", here, at("22:00"));
  assert.equal(noRoute.kind, "none");
  assert.equal(noRoute.line, "no: no connection");
});

test("walking wins when it arrives first or the place is close; the ride chip still shows the ride", () => {
  // The tram arrives 22:25; a 20-minute walk from 22:00 arrives 22:20.
  const quick = planTrip(fakeNet({ journeys: [tramTrip], walkMinutes: 20 }), fakeApi, zoo, "any", here, at("22:00"));
  assert.equal(quick.kind, "walk");
  assert.equal(quick.line, "It's quicker to walk, about 20 minutes.");
  if (quick.kind === "walk") assert.deepEqual(quick.journeys, [tramTrip]);
  // The same, from the ride chip: the ride.
  assert.equal(planTrip(fakeNet({ journeys: [tramTrip], walkMinutes: 20 }), fakeApi, zoo, "any", here, at("22:00"), false, true).kind, "trip");
  // A 25-minute walk arrives with the tram: the tram (walking is not sooner).
  assert.equal(planTrip(fakeNet({ journeys: [tramTrip], walkMinutes: 25 }), fakeApi, zoo, "any", here, at("22:00")).kind, "trip");
  // Within WALK_ONLY_M: a walk, even when the ride is faster or there is none.
  const near = { name: "Corner", lat: here.lat + (WALK_ONLY_M - 50) / 111_195, lon: here.lon };
  assert.equal(planTrip(fakeNet({ journeys: [tramTrip], walkMinutes: 60 }), fakeApi, near, "any", here, at("22:00")).kind, "walk");
  const nearNone = planTrip(fakeNet({ journeys: null, reason: "no connection", walkMinutes: 8 }), fakeApi, near, "any", here, at("22:00"));
  assert.equal(nearNone.kind, "walk");
  assert.equal(nearNone.line, "It's quicker to walk, about 8 minutes.");
});

test("already there: no plan, Val says so", () => {
  const net = fakeNet({ journeys: [tramTrip], walkMinutes: 1 });
  const home = planTrip(net, fakeApi, { name: "Home", lat: here.lat + 0.0003, lon: here.lon }, "any", here, at("22:00"));
  assert.equal(home.kind, "here");
  assert.equal(home.line, "You're home!");
  if (home.kind === "here") assert.equal(home.card.metric, home.line); // the same words on the card and aloud
  assert.equal(planTrip(net, fakeApi, { name: "Zoo", lat: here.lat, lon: here.lon }, "any", here, at("22:00")).line, "You're already at Zoo!");
  assert.equal(net.asked.length, 0);
});

// ---- Where we are, and home ----

test("a fresh, good fix is used at once; otherwise the next good one", async () => {
  let now = 1_000_000;
  const loc = new Locator(() => now);
  loc.feed(51.05, 13.74, 12);
  let waited = false;
  assert.deepEqual(await loc.locate(1000, () => (waited = true)), { fix: { lat: 51.05, lon: 13.74, acc: 12, at: 1_000_000 }, old: false });
  assert.equal(waited, false);

  now += FRESH_FIX_MS + 1;
  const p = loc.locate(1000, () => (waited = true));
  assert.equal(waited, true);
  loc.feed(51.06, 13.75, GOOD_FIX_M + 50); // too rough to end the wait
  loc.feed(51.07, 13.76, 8);
  const r = await p;
  assert.ok("fix" in r && !r.old && r.fix.lat === 51.07);
});

test("no new fix in time: the last one up to 10 minutes old, else give up", async () => {
  let now = 0;
  const loc = new Locator(() => now);
  assert.deepEqual(await loc.locate(5), { error: "none" });
  loc.feed(51.05, 13.74, 300);
  now = OLD_FIX_MS - 1;
  const r = await loc.locate(5);
  assert.ok("fix" in r && r.old);
  now = OLD_FIX_MS + 1;
  assert.deepEqual(await loc.locate(5), { error: "none" });
  loc.feed(Number.NaN, 13, 5); // ignored
  assert.deepEqual(await loc.locate(5), { error: "none" });
});

test("a fix is stamped with the time it was taken, not when it arrived", () => {
  assert.equal(fixTime(100_000, 9 * 60_000), 100_000 - 9 * 60_000);
  assert.equal(fixTime(100_000), 100_000);
  assert.equal(fixTime(100_000, -5), 100_000);
  assert.equal(fixTime(100_000, Number.NaN), 100_000);
});

test("the chip's 9-minute-old last fix is not fresh: a question waits, then uses it only inside OLD_FIX_MS", async () => {
  let now = 1_000_000;
  const loc = new Locator(() => now);
  loc.feed(51.05, 13.74, 12, 9 * 60_000);
  let waited = false;
  const p = loc.locate(5, () => (waited = true));
  assert.equal(waited, true, "an old fix never answers at once");
  const r = await p;
  assert.ok("fix" in r && r.old && r.fix.at === now - 9 * 60_000);
  now += 61_000; // now 10 min 1 s since the fix was really taken
  assert.deepEqual(await loc.locate(5), { error: "none" });
});

test("an old fix arriving while a question waits does not end the wait as fresh; a live one does", async () => {
  let now = 1_000_000;
  const loc = new Locator(() => now);
  const p = loc.locate(10_000);
  loc.feed(51.05, 13.74, 12, 5 * 60_000);
  loc.feed(51.06, 13.75, 8, 0);
  const r = await p;
  assert.ok("fix" in r && !r.old && r.fix.lat === 51.06);
  loc.feed(51.07, 13.76, 8, 60_000); // older than what we have: ignored
  const again = await loc.locate(5);
  assert.ok("fix" in again && again.fix.lat === 51.06);
});

test("location switched off ends a waiting question", async () => {
  const loc = new Locator(() => 0);
  const p = loc.locate(10_000);
  loc.fail();
  assert.deepEqual(await p, { error: "off" });
});

test("home is kept in local storage only, rounded, and validated", () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  assert.equal(loadHome(store), null);
  assert.equal(saveHome({ lat: 51.0504321, lon: 13.7372999 }, store), true);
  assert.deepEqual(loadHome(store), { lat: 51.05043, lon: 13.7373 });
  m.set(HOME_KEY, "{\"lat\":400,\"lon\":1}");
  assert.equal(loadHome(store), null);
  m.set(HOME_KEY, "not json");
  assert.equal(loadHome(store), null);
  assert.equal(saveHome({ lat: 1, lon: 1 }, null), false);
  assert.equal(loadHome(null), null);
});

// ---- Val's replies and the map feature ----

const notes: Notes = { all: () => [], add: () => undefined };
const cmd = (name: string, args: Record<string, unknown>): Command => ({ name, args, text: "something", confidence: 1 });

test("transit commands become page actions; Val speaks once planned", () => {
  assert.deepEqual(respond(cmd("transit", { dest: "home", mode: "tram" }), notes), { action: { kind: "transit", dest: "home", mode: "tram" }, reply: "" });
  assert.deepEqual(respond(cmd("transit", { dest: "zoo", mode: "rocket" }), notes).action, { kind: "transit", dest: "zoo", mode: "any" });
  assert.deepEqual(respond(cmd("transit", { dest: " " }), notes), { action: { kind: "shrug" }, reply: LINES.noDest });
  assert.deepEqual(respond(cmd("next_departure", { stop: "postplatz", mode: "bus" }), notes).action, { kind: "departures", stop: "postplatz", mode: "bus" });
  assert.deepEqual(respond(cmd("next_departure", {}), notes).action, { kind: "departures", stop: "", mode: "any" });
  assert.deepEqual(respond(cmd("set_home", {}), notes), { action: { kind: "setHome" }, reply: "" });
});

test("a trip opens the map through the feature machine, and a second trip re-plans the open map", () => {
  const trip = { dest: "home", mode: "tram" };
  let s: FeatureState = homeState();
  let out = featureStep(s, { type: "request", req: { kind: "map", trip } });
  assert.equal(out.state.phase, "revealing");
  assert.deepEqual(out.effects, [{ do: "reveal", req: { kind: "map", trip }, token: 1 }]);
  s = out.state;
  const later = { dest: "zoo", mode: "bus" };
  s = featureStep(s, { type: "request", req: { kind: "map", trip: later } }).state; // asked again while revealing
  assert.deepEqual(s.req, { kind: "map", trip: later });
  out = featureStep(s, { type: "revealed", token: 1 });
  assert.deepEqual(out.effects, [{ do: "show", req: { kind: "map", trip: later }, token: 1 }]);
  out = featureStep(out.state, { type: "request", req: { kind: "map", trip } });
  assert.deepEqual(out.effects, [{ do: "trip", trip }]);
});
