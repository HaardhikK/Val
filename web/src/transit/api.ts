import { decodeTransit, type TransitNames } from "./decode";
import { describeDepartures, describeJourney, describePlan, spokenStop } from "./describe";
import { berlinClock, clockText, daysBetween, TransitRouter, WINDOW_DAYS } from "./raptor";

// The one boundary between the map page and the offline timetable router (decode.ts, raptor.ts, describe.ts in this
// folder). The map, the card logic (card.ts) and the voice flow use only these types and the TransitApi object, so
// the router can change shape without touching them: adapt it here. The shapes mirror the router's own, so its
// journeys pass through unchanged. Tests pass a fake TransitApi.

export interface LatLon {
  lat: number;
  lon: number;
}

export interface StopRef extends LatLon {
  index: number;
  name: string;
}

/** 0 tram, 1 bus, 2 rail, 3 ferry, 4 other. */
export type Mode = 0 | 1 | 2 | 3 | 4;

export interface WalkLeg {
  walk: true;
  /** Absent when the walk starts at the origin. */
  fromStop?: StopRef;
  /** Absent when the walk ends at the destination. */
  toStop?: StopRef;
  minutes: number;
}

export interface RideLeg {
  walk: false;
  line: string;
  mode: Mode;
  color: string;
  headsign: string;
  fromStop: StopRef;
  toStop: StopRef;
  depart: Date;
  arrive: Date;
  /** Stops travelled. */
  stops: number;
  /** [lon, lat] of every stop from boarding to alighting (drawn straight, no shapes). */
  path: [number, number][];
}

export type Leg = WalkLeg | RideLeg;

export interface Journey {
  legs: Leg[];
  /** When to start walking from the origin. */
  leave: Date;
  arrive: Date;
  rides: number;
  transfers: number;
}

export interface PlanResult {
  /** Up to three journeys, best first; null when there is none. */
  journeys: Journey[] | null;
  reason?: "timetable expired" | "no stops nearby" | "no connection";
  /** Straight-line walking estimate, for "just walk". */
  walkMinutes: number;
}

export interface Departure {
  line: string;
  mode: Mode;
  color: string;
  headsign: string;
  depart: Date;
  /** Whole minutes from the query time (0 = leaving now). */
  inMinutes: number;
}

/** A loaded timetable. */
export interface Network {
  readonly stopCount: number;
  stop(i: number): StopRef;
  /** Index of the stop with this name (case, accents and "Dresden" ignored), or -1; one `mode` serves wins. */
  findStop(name: string, mode?: Mode): number;
  /** Index of the nearest stop within maxM metres (the nearest `mode` serves, if any), or -1. */
  nearestStop(lat: number, lon: number, maxM?: number, mode?: Mode): number;
  plan(when: Date, from: LatLon, to: LatLon): PlanResult;
  /** null when the timetable has expired. */
  nextDepartures(stop: number, when: Date, n: number): Departure[] | null;
  /** Days the timetable still covers from `when` (1 = its last day; 0 or less = expired). */
  daysLeft(when: Date): number;
}

export interface TransitApi {
  /** Decodes transit.bin with transit-stops.json; throws on a malformed pack. */
  load(bin: ArrayBuffer, stopsJson: unknown): Network;
  /** One spoken line for a journey ("Walk 4 minutes to …, take tram 1 at 22:14 …"). */
  describeJourney(j: Journey): string;
  /** One spoken line for a plan without journeys (expired, no stops nearby, no connection). */
  describePlan(r: PlanResult): string;
  /** `missing`: the mode asked for when none of it leaves soon ("No tram soon from …; the next is bus 62 …"). */
  describeDepartures(stopName: string, deps: Departure[] | null, missing?: string): string;
  /** "22:14" in Dresden time. */
  clock(d: Date): string;
  /** A stop's name for people: "Dresden Postplatz" → "Postplatz". */
  stopName(name: string): string;
}

const session = { liveNoteGiven: false }; // "timetable, not live" is said once per page session

/** The router from decode.ts / raptor.ts / describe.ts; one router per loaded pack, reused for every query. */
export const transitApi: TransitApi = {
  load(bin, json) {
    const r = new TransitRouter(decodeTransit(bin, json as TransitNames));
    return {
      stopCount: r.net.nStops,
      stop: (i) => r.stop(i),
      findStop: (name, mode) => r.findStop(name, mode),
      nearestStop: (lat, lon, maxM, mode) => r.nearestStop(lat, lon, maxM, mode),
      plan: (when, from, to) => r.plan(when, from.lat, from.lon, to.lat, to.lon),
      nextDepartures: (stop, when, n) => r.nextDepartures(stop, when, n),
      daysLeft: (when) => WINDOW_DAYS - daysBetween(r.net.baseDate, berlinClock(when).ymd),
    };
  },
  describeJourney: (j) => describeJourney(j, session),
  describePlan: (p) => describePlan(p, session),
  describeDepartures: (stop, deps, missing) => describeDepartures(stop, deps, session, missing),
  clock: clockText,
  stopName: spokenStop,
};
