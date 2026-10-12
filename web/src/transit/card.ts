// What the map shows for trams and buses: the result card's words, the boarding labels, the journey's lines, and
// the stop departures list. Pure (no DOM, no map), unit-tested; view.ts draws it.
import type { Departure, Journey, LatLon, Mode, Network, PlanResult, RideLeg, TransitApi } from "./api";
import { haversine } from "../map/geo";
import { walkLine } from "./describe";
import { LINES } from "./trip";

export type Clock = (d: Date) => string;

/** A destination this close is walked, whatever the timetable says. */
export const WALK_ONLY_M = 700;
/** This close, we are already there ("You're home!", the same words on the card and in Val's voice). */
export const HERE_M = 60;

/** The mode word of a request as the timetable's mode: tram 0, bus 1, anything else undefined. */
export const modeOfWord = (mode: string): Mode | undefined => (mode === "tram" ? 0 : mode === "bus" ? 1 : undefined);
/** From this many days left in the timetable window, the cards say when it ends. */
export const ENDS_SOON_DAYS = 4;

export const MODE_TAG: Record<Mode, string> = { 0: "TRAM", 1: "BUS", 2: "TRAIN", 3: "FERRY", 4: "LINE" };
const MODE_WORD: Record<Mode, string> = { 0: "tram", 1: "bus", 2: "train", 3: "ferry", 4: "line" };
/** Used when a line has no colour of its own (or a malformed one). */
const MODE_COLOR: Record<Mode, string> = { 0: "#e2001a", 1: "#8ab4ff", 2: "#c9a0ff", 3: "#7fd8d0", 4: "#c9a0ff" };
/** The walk legs and the walking route: dotted pink. */
export const WALK_COLOR = "#ffb3c8";

const modeOf = (m: number): Mode => (m >= 0 && m <= 4 ? (m as Mode) : 4);

/** The line's colour as #rrggbb, or the mode's colour: only a plain hex colour reaches the map style. */
export function lineColor(color: unknown, mode: number): string {
  return typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : MODE_COLOR[modeOf(mode)];
}

/** "TRAM 1 · 22:14": the label at a ride's boarding stop. */
export function boardLabel(leg: RideLeg, clock: Clock): string {
  return `${MODE_TAG[modeOf(leg.mode)]} ${leg.line} · ${clock(leg.depart)}`;
}

/** "walk 4 min → tram 1 → 6 stops → walk 3 min"; each step keeps its words together (no-break spaces) when it wraps. */
export function legList(j: Journey): string {
  const parts: string[] = [];
  for (const leg of j.legs) {
    if (leg.walk) parts.push(`walk ${leg.minutes} min`);
    else parts.push(`${MODE_WORD[modeOf(leg.mode)]} ${leg.line}`, `${leg.stops} stop${leg.stops === 1 ? "" : "s"}`);
  }
  return parts.map((p) => p.replace(/ /g, NBSP)).join(" → ");
}

const NBSP = "\u00a0";

export const changesText = (n: number) => (n <= 0 ? "direct" : `${n} change${n === 1 ? "" : "s"}`);

export interface CardText {
  title: string;
  /** Amber line. */
  metric: string;
  /** Dim line under it. */
  hint: string;
  /** The leg list (journeys only). */
  legs: string;
  /** "1/3" when there is more than one journey to cycle through. */
  next: string | null;
}

const firstRide = (j: Journey) => j.legs.find((l): l is RideLeg => !l.walk);

/**
 * "timetable, not live", or when the timetable runs out soon, how soon ("timetable ends in 3 days"). `short` for
 * the journey card's one line at phone width: "not live", "ends in 3 days".
 */
export function timetableNote(daysLeft = Infinity, short = false): string {
  const word = short ? "" : "timetable ";
  if (daysLeft > ENDS_SOON_DAYS) return short ? "not live" : "timetable, not live";
  return daysLeft <= 1 ? `${word}ends today` : `${word}ends in ${daysLeft} days`;
}

/** "BUS 161 ▸": the chip that offers the ride when walking is quicker. */
export function rideChip(j: Journey | undefined): string {
  const ride = j && firstRide(j);
  return ride ? `${MODE_TAG[modeOf(ride.mode)]} ${ride.line} ▸` : "Tram/Bus ▸";
}

/** The card for journey i of n: departure (amber), arrival, changes, the legs, and that it is the timetable. */
export function journeyCard(j: Journey, i: number, n: number, dest: string, clock: Clock, daysLeft?: number): CardText {
  const ride = firstRide(j);
  return {
    title: dest,
    metric: ride ? `${MODE_TAG[modeOf(ride.mode)]} ${ride.line} · dep ${clock(ride.depart)}` : `Walk · leave ${clock(j.leave)}`,
    hint: `Arr ${clock(j.arrive)} · ${changesText(j.transfers)} · ${timetableNote(daysLeft, true)}`,
    legs: legList(j),
    next: n > 1 ? `${i + 1}/${n}` : null,
  };
}

/** The card when there is no journey: why, and the walk instead. */
export function noJourneyCard(r: PlanResult, dest: string): CardText {
  const why = r.reason === "timetable expired" ? "Timetable expired" : r.reason === "no stops nearby" ? "No stop close enough" : "No tram or bus now";
  return { title: dest, metric: why, hint: r.walkMinutes > 0 ? `On foot about ${r.walkMinutes} min` : "", legs: "", next: null };
}

export const NO_TIMETABLE_CARD = (dest: string): CardText => ({ title: dest, metric: "No timetable yet", hint: "Walking works", legs: "", next: null });

/**
 * Journeys with the wanted mode first: with "tram" or "bus", the journeys that ride only that mode come first.
 * `matched` is false when none does (the order is then unchanged).
 */
export function preferMode(journeys: Journey[], mode: string): { journeys: Journey[]; matched: boolean } {
  const want = mode === "tram" ? 0 : mode === "bus" ? 1 : -1;
  if (want < 0) return { journeys, matched: true };
  const fits = (j: Journey) => j.legs.some((l) => !l.walk) && j.legs.every((l) => l.walk || l.mode === want);
  const yes = journeys.filter(fits);
  return yes.length ? { journeys: [...yes, ...journeys.filter((j) => !fits(j))], matched: true } : { journeys, matched: false };
}

export interface DepartureRow {
  tag: string;
  headsign: string;
  when: string;
  color: string;
}

/** The stop card's rows: line, headsign, minutes from now (the clock time from an hour on). */
export function departureRows(deps: Departure[], clock: Clock, max = 4): DepartureRow[] {
  return deps.slice(0, max).map((d) => ({
    tag: `${MODE_TAG[modeOf(d.mode)]} ${d.line}`,
    headsign: d.headsign,
    when: d.inMinutes <= 0 ? "now" : d.inMinutes < 60 ? `${d.inMinutes} min` : clock(d.depart),
    color: lineColor(d.color, d.mode),
  }));
}

/**
 * Departures of one mode when asked for one ("next tram at …"), all of them otherwise. When none of that mode
 * leaves soon, all of them, and `missing` names the mode for Val ("No tram soon from …").
 */
export function filterMode(deps: Departure[], mode: string): { deps: Departure[]; missing?: string } {
  const want = mode === "tram" ? 0 : mode === "bus" ? 1 : -1;
  if (want < 0) return { deps };
  const some = deps.filter((d) => d.mode === want);
  return some.length || !deps.length ? { deps: some } : { deps, missing: mode };
}

export type TripPlan =
  /** No timetable, or no journey: the card says why, Val says the line. */
  | { kind: "none"; card: CardText; line: string }
  /** No fix yet: the card waits for one. */
  | { kind: "wait"; card: CardText; line: string }
  | { kind: "trip"; journeys: Journey[]; line: string }
  /** Walking is quicker (or the place is close): the walk route; the journeys stay as the ride chip. */
  | { kind: "walk"; minutes: number; journeys: Journey[] | null; line: string }
  /** Already there. */
  | { kind: "here"; card: CardText; line: string };

/**
 * What a tram/bus request to `dest` comes to: the decisions of the map's trip flow, without the map. A walk wins
 * when it arrives before the chosen ride or the place is within WALK_ONLY_M, unless `rideOnly` (the ride chip).
 */
export function planTrip(
  net: Network | null,
  api: Pick<TransitApi, "describeJourney" | "describePlan">,
  dest: StopName,
  mode: string,
  origin: LatLon | null,
  when: Date,
  gpsOff = false,
  rideOnly = false,
): TripPlan {
  if (!net) return { kind: "none", card: NO_TIMETABLE_CARD(dest.name), line: LINES.noTimetable };
  if (!origin) {
    const hint = gpsOff ? "Turn on location for a trip" : "Trip starts once GPS finds you";
    return { kind: "wait", card: { title: dest.name, metric: "", hint, legs: "", next: null }, line: gpsOff ? LINES.gpsOff : LINES.noFix };
  }
  const dist = haversine(origin.lat, origin.lon, dest.lat, dest.lon);
  if (dist <= HERE_M) {
    const home = dest.name === "Home";
    const card = { title: dest.name, metric: home ? "You're home!" : "You're there!", hint: "", legs: "", next: null };
    return { kind: "here", card, line: home ? "You're home!" : `You're already at ${dest.name}!` };
  }
  const res = net.plan(when, origin, dest);
  const close = dist <= WALK_ONLY_M;
  if (!res.journeys?.length) {
    if (close && !rideOnly) return { kind: "walk", minutes: res.walkMinutes, journeys: null, line: walkLine(res.walkMinutes) };
    return { kind: "none", card: noJourneyCard(res, dest.name), line: api.describePlan(res) };
  }
  const { journeys, matched } = preferMode(res.journeys, mode);
  const walkArrives = when.getTime() + res.walkMinutes * 60_000;
  if (!rideOnly && (close || walkArrives < journeys[0].arrive.getTime())) {
    return { kind: "walk", minutes: res.walkMinutes, journeys, line: walkLine(res.walkMinutes) };
  }
  const line = api.describeJourney(journeys[0]);
  return { kind: "trip", journeys, line: matched ? line : `There's no ${mode} all the way, but here's a trip. ${line}` };
}

type StopName = LatLon & { name: string };

type Line = GeoJSON.Feature<GeoJSON.LineString, { kind: "walk" | "ride"; color: string }>;

/**
 * The journey as map lines: walk legs (pink, dotted by the layer) from the origin, between stops and to the
 * destination; ride legs straight between their stops in the line colour.
 */
export function journeyLines(j: Journey, from: LatLon, to: LatLon): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const features: Line[] = [];
  const at = (p: LatLon): [number, number] => [p.lon, p.lat];
  j.legs.forEach((leg, i) => {
    if (leg.walk) {
      const prev = j.legs[i - 1];
      const next = j.legs[i + 1];
      const a = leg.fromStop ?? (prev && !prev.walk ? prev.toStop : from);
      const b = leg.toStop ?? (next && !next.walk ? next.fromStop : to);
      features.push({ type: "Feature", properties: { kind: "walk", color: WALK_COLOR }, geometry: { type: "LineString", coordinates: [at(a), at(b)] } });
    } else {
      const coords = leg.path.length >= 2 ? leg.path : [at(leg.fromStop), at(leg.toStop)];
      features.push({ type: "Feature", properties: { kind: "ride", color: lineColor(leg.color, leg.mode) }, geometry: { type: "LineString", coordinates: coords } });
    }
  });
  return { type: "FeatureCollection", features };
}
