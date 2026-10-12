// Offline tram/bus journey planning on the decoded timetable: RAPTOR (Delling, Pajor, Werneck 2012) for at
// most three rides (two changes), plus "next departures at a stop". Pure: no DOM, no clock of its own.
//
// Times inside are seconds after midnight of the query's service day (Europe/Berlin). A service day's
// stop times run past 1440 minutes after midnight, so trips of yesterday's service day are scanned too,
// shifted by one day. All per-query state lives in typed arrays allocated once per network.
import { haversine } from "../map/geo";
import type { Mode, Transit } from "./decode";

export const MAX_RIDES = 3;
/** Straight-line access and egress: stops within this radius, walked at WALK_MS with a DETOUR factor. */
export const ACCESS_RADIUS_M = 600;
export const DETOUR = 1.3;
export const WALK_MS = 1.3;
export const MAX_ACCESS_S = 600;
/** The day masks cover this many days from the pack's base date. */
export const WINDOW_DAYS = 14;
/** A journey with fewer changes wins over a faster one when it arrives at most this much later. */
export const CHANGE_PENALTY_S = 300;
/** Getting off and onto another line at the same (merged) stop takes at least this long. */
export const MIN_CHANGE_S = 90;

const INF = 0x3fffffff;
const DAY_S = 86_400;

export interface StopRef {
  index: number;
  name: string;
  lat: number;
  lon: number;
}

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
  /** Stops travelled (alighting position minus boarding position). */
  stops: number;
  /** [lon, lat] of every stop from boarding to alighting, for drawing on the map. */
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

export type NoRouteReason = "timetable expired" | "no stops nearby" | "no connection";

export interface PlanResult {
  /** Up to three Pareto-optimal journeys (arrival vs changes), best first; null when there is none. */
  journeys: Journey[] | null;
  reason?: NoRouteReason;
  /** Straight-line walk estimate origin → destination (with the detour factor), for "just walk". */
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

let berlin: Intl.DateTimeFormat | undefined;

/** Wall clock in Europe/Berlin: the date as YYYYMMDD and the seconds after local midnight. */
export function berlinClock(d: Date): { ymd: number; seconds: number } {
  berlin ??= new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, number> = {};
  for (const part of berlin.formatToParts(d)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { ymd: p.year * 10000 + p.month * 100 + p.day, seconds: (p.hour % 24) * 3600 + p.minute * 60 + p.second };
}

/** "22:14" in Europe/Berlin. */
export function clockText(d: Date): string {
  const s = berlinClock(d).seconds;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Whole days from YYYYMMDD a to YYYYMMDD b. */
export function daysBetween(a: number, b: number): number {
  const utc = (v: number) => Date.UTC(Math.floor(v / 10000), (Math.floor(v / 100) % 100) - 1, v % 100);
  return Math.round((utc(b) - utc(a)) / DAY_S / 1000);
}

/** Walking seconds for a straight-line distance, or INF beyond the access radius. */
function accessSeconds(m: number): number {
  if (m > ACCESS_RADIUS_M) return INF;
  const s = Math.ceil((m * DETOUR) / WALK_MS);
  return s > MAX_ACCESS_S ? INF : s;
}

const minutesOf = (s: number) => Math.round(s / 60);

export class TransitRouter {
  private readonly n: number;
  private readonly firstDep: Uint16Array;
  private readonly maxSpan: Uint16Array;
  private readonly sorted: Uint8Array;
  // Labels per round k (index k * n + stop). tau = best arrival with k rides (ride or ride + footpath);
  // rideArr = arrival by the k-th ride itself, which a footpath label never overwrites.
  private readonly tau: Int32Array;
  private readonly rideArr: Int32Array;
  private readonly tauFrom: Int32Array; // footpath origin stop, or -1 for a ride (or access) label
  private readonly rideTrip: Int32Array;
  private readonly rideDay: Uint8Array; // 0 today's service day, 1 yesterday's
  private readonly rideBoard: Uint16Array;
  private readonly rideAlight: Uint16Array;
  private readonly rideRoute: Uint32Array;
  private readonly best: Int32Array;
  private readonly access: Int32Array;
  private readonly egress: Int32Array;
  private readonly egressList: Uint32Array;
  private readonly marked: Uint8Array;
  private readonly markList: Uint32Array;
  private readonly nextList: Uint32Array;
  private readonly routeFirst: Int32Array;
  private readonly routeList: Uint32Array;
  private foundTrip = -1;
  private foundDay = 0;

  constructor(readonly net: Transit) {
    const n = (this.n = net.nStops);
    const rounds = (MAX_RIDES + 1) * n;
    this.firstDep = new Uint16Array(net.nTrips);
    for (let t = 0; t < net.nTrips; t++) this.firstDep[t] = net.stopTimes[net.tripTimeStart[t]];
    this.maxSpan = new Uint16Array(net.nRoutes);
    this.sorted = new Uint8Array(net.nRoutes);
    for (let r = 0; r < net.nRoutes; r++) {
      const t0 = net.routeTripStart[r];
      let span = 0;
      let ok = 1;
      for (let t = t0; t < t0 + net.routeTrips[r]; t++) {
        const base = net.tripTimeStart[t];
        for (let i = 0; i < net.routeLen[r]; i++) span = Math.max(span, net.stopTimes[base + i] - this.firstDep[t]);
        if (t > t0 && this.firstDep[t] < this.firstDep[t - 1]) ok = 0;
      }
      this.maxSpan[r] = span;
      this.sorted[r] = ok; // an unsorted route still routes correctly, only without the binary search
    }
    this.tau = new Int32Array(rounds);
    this.rideArr = new Int32Array(rounds);
    this.tauFrom = new Int32Array(rounds);
    this.rideTrip = new Int32Array(rounds);
    this.rideDay = new Uint8Array(rounds);
    this.rideBoard = new Uint16Array(rounds);
    this.rideAlight = new Uint16Array(rounds);
    this.rideRoute = new Uint32Array(rounds);
    this.best = new Int32Array(n);
    this.access = new Int32Array(n);
    this.egress = new Int32Array(n);
    this.egressList = new Uint32Array(n);
    this.marked = new Uint8Array(n);
    this.markList = new Uint32Array(n);
    this.nextList = new Uint32Array(n);
    this.routeFirst = new Int32Array(net.nRoutes).fill(-1);
    this.routeList = new Uint32Array(net.nRoutes);
  }

  stop(i: number): StopRef {
    return { index: i, name: this.net.names.stops[i], lat: this.net.stopLat[i], lon: this.net.stopLon[i] };
  }

  /** Something of this mode (0 tram, 1 bus, …) departs from stop s; any mode when mode < 0. */
  serves(s: number, mode: number): boolean {
    const net = this.net;
    for (let e = net.stopRouteStart[s]; e < net.stopRouteStart[s + 1]; e++) {
      const r = net.stopRouteRoute[e];
      if ((mode < 0 || net.routeMode[r] === mode) && net.stopRoutePos[e] < net.routeLen[r] - 1) return true;
    }
    return false;
  }

  /**
   * Index of the stop with this name, or -1. Case, accents and the city ("Dresden Postplatz",
   * "…, Dresden") are ignored; an exact match wins over a prefix match, which wins over a contained one. With a
   * mode, a stop that mode serves wins within the same kind of match ("next tram at Hauptbahnhof").
   */
  findStop(name: string, mode = -1): number {
    const norm = (s: string) =>
      s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/^dresden\s+|,\s*dresden$/g, "").trim();
    const q = norm(name);
    if (!q) return -1;
    const names = this.net.names.stops.map(norm);
    let first = -1;
    for (const hit of [(s: string) => s === q, (s: string) => s.startsWith(q), (s: string) => s.includes(q)]) {
      for (let i = 0; i < names.length; i++) {
        if (!hit(names[i])) continue;
        if (mode < 0 || this.serves(i, mode)) return i;
        if (first < 0) first = i;
      }
    }
    return first;
  }

  /** Index of the nearest stop within maxM metres (with a mode, the nearest it serves, if any), or -1. */
  nearestStop(lat: number, lon: number, maxM = ACCESS_RADIUS_M, mode = -1): number {
    let best = -1;
    let bestD = maxM;
    let any = -1;
    let anyD = maxM;
    for (let s = 0; s < this.n; s++) {
      const d = haversine(lat, lon, this.net.stopLat[s], this.net.stopLon[s]);
      if (d <= anyD) [any, anyD] = [s, d];
      if (d <= bestD && (mode < 0 || this.serves(s, mode))) [best, bestD] = [s, d];
    }
    return best >= 0 ? best : any;
  }

  /**
   * Earliest trip instance of route r leaving position i at or after `t` seconds; sets foundTrip/foundDay
   * and returns its departure in seconds (INF when none). `day` is today's index in the day masks.
   */
  private earliest(r: number, i: number, t: number, day: number): number {
    const net = this.net;
    const t0 = net.routeTripStart[r];
    const t1 = t0 + net.routeTrips[r];
    let bestAbs = INF; // minutes after today's midnight
    this.foundTrip = -1;
    const minMin = Math.ceil(t / 60);
    for (let back = 0; back <= 1; back++) {
      const d = day - back;
      if (d < 0) break;
      const bit = 1 << d;
      const shift = back * 1440;
      const th = minMin + shift; // threshold in that service day's minutes
      let lo = t0;
      if (this.sorted[r]) {
        const lower = th - this.maxSpan[r];
        let hi = t1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (this.firstDep[mid] < lower) lo = mid + 1;
          else hi = mid;
        }
      }
      for (let k = lo; k < t1; k++) {
        if (this.sorted[r] && this.firstDep[k] - shift >= bestAbs) break;
        if (!(net.tripMask[k] & bit)) continue;
        const dep = net.stopTimes[net.tripTimeStart[k] + i];
        if (dep >= th && dep - shift < bestAbs) {
          bestAbs = dep - shift;
          this.foundTrip = k;
          this.foundDay = back;
        }
      }
    }
    return bestAbs === INF ? INF : bestAbs * 60;
  }

  /** Plans from (lat, lon) to (lat, lon), leaving at `when`. */
  plan(when: Date, fromLat: number, fromLon: number, toLat: number, toLon: number): PlanResult {
    const net = this.net;
    const n = this.n;
    const walkMinutes = Math.max(1, minutesOf((haversine(fromLat, fromLon, toLat, toLon) * DETOUR) / WALK_MS));
    const { ymd, seconds: now } = berlinClock(when);
    const day = daysBetween(net.baseDate, ymd);
    if (day < 0 || day >= WINDOW_DAYS) return { journeys: null, reason: "timetable expired", walkMinutes };

    const { tau, rideArr, tauFrom, best, access, egress, marked, routeFirst } = this;
    tau.fill(INF);
    rideArr.fill(INF);
    tauFrom.fill(-1);
    best.fill(INF);
    let nMark = 0;
    let nEgress = 0;
    for (let s = 0; s < n; s++) {
      access[s] = accessSeconds(haversine(fromLat, fromLon, net.stopLat[s], net.stopLon[s]));
      egress[s] = accessSeconds(haversine(toLat, toLon, net.stopLat[s], net.stopLon[s]));
      if (egress[s] < INF) this.egressList[nEgress++] = s;
      if (access[s] < INF) {
        tau[s] = best[s] = now + access[s];
        marked[s] = 1;
        this.markList[nMark++] = s;
      }
    }
    if (nMark === 0 || nEgress === 0) {
      marked.fill(0);
      return { journeys: null, reason: "no stops nearby", walkMinutes };
    }

    let bestTarget = INF;
    const targetArr = [INF, INF, INF, INF];
    const targetStop = [-1, -1, -1, -1];
    for (let k = 1; k <= MAX_RIDES && nMark > 0; k++) {
      const prev = (k - 1) * n;
      const cur = k * n;
      // Routes through the stops improved last round, each from its earliest such position.
      let nRoutes = 0;
      for (let m = 0; m < nMark; m++) {
        const s = this.markList[m];
        marked[s] = 0;
        for (let e = net.stopRouteStart[s]; e < net.stopRouteStart[s + 1]; e++) {
          const r = net.stopRouteRoute[e];
          const pos = net.stopRoutePos[e];
          if (routeFirst[r] < 0) {
            this.routeList[nRoutes++] = r;
            routeFirst[r] = pos;
          } else if (pos < routeFirst[r]) routeFirst[r] = pos;
        }
      }
      nMark = 0;
      for (let q = 0; q < nRoutes; q++) {
        const r = this.routeList[q];
        const start = net.routeStopStart[r];
        const len = net.routeLen[r];
        let trip = -1;
        let back = 0;
        let board = 0;
        for (let i = routeFirst[r]; i < len; i++) {
          const s = net.routeStops[start + i];
          let dep = INF;
          if (trip >= 0) {
            dep = (net.stopTimes[net.tripTimeStart[trip] + i] - back * 1440) * 60;
            if (dep < best[s] && dep < bestTarget) {
              const at = cur + s;
              tau[at] = rideArr[at] = best[s] = dep;
              tauFrom[at] = -1;
              this.rideTrip[at] = trip;
              this.rideDay[at] = back;
              this.rideBoard[at] = board;
              this.rideAlight[at] = i;
              this.rideRoute[at] = r;
              if (egress[s] < INF && dep + egress[s] < bestTarget) bestTarget = dep + egress[s];
              if (!marked[s]) {
                marked[s] = 1;
                this.markList[nMark++] = s;
              }
            }
          }
          // Arrived here by a ride (not on foot, not at the start): changing lines takes MIN_CHANGE_S.
          const ready = tau[prev + s] + (k > 1 && tauFrom[prev + s] < 0 ? MIN_CHANGE_S : 0);
          if (ready < INF && ready <= dep && i < len - 1) {
            const d2 = this.earliest(r, i, ready, day);
            if (d2 < dep) {
              trip = this.foundTrip;
              back = this.foundDay;
              board = i;
            }
          }
        }
        routeFirst[r] = -1;
      }
      // Footpaths from the stops this round's rides reached (one walk, never chained).
      const nRide = nMark;
      for (let m = 0; m < nRide; m++) {
        const s = this.markList[m];
        const arr = rideArr[cur + s];
        for (let e = net.transferStart[s]; e < net.transferStart[s + 1]; e++) {
          const t = net.transferTo[e];
          if (t === s) continue;
          const a = arr + net.transferSec[e];
          if (a < best[t] && a < bestTarget) {
            tau[cur + t] = best[t] = a;
            tauFrom[cur + t] = s;
            if (egress[t] < INF && a + egress[t] < bestTarget) bestTarget = a + egress[t];
            if (!marked[t]) {
              marked[t] = 1;
              this.markList[nMark++] = t;
            }
          }
        }
      }
      for (let e = 0; e < nEgress; e++) {
        const s = this.egressList[e];
        const a = tau[cur + s];
        if (a < INF && a + egress[s] < targetArr[k]) {
          targetArr[k] = a + egress[s];
          targetStop[k] = s;
        }
      }
    }
    for (let m = 0; m < nMark; m++) marked[this.markList[m]] = 0;

    const midnight = when.getTime() - (when.getTime() % 1000) - now * 1000;
    const found: Journey[] = [];
    let soFar = INF;
    for (let k = 1; k <= MAX_RIDES; k++) {
      if (targetArr[k] < soFar) {
        soFar = targetArr[k];
        found.push(this.reconstruct(k, targetStop[k], targetArr[k], midnight));
      }
    }
    if (found.length === 0) return { journeys: null, reason: "no connection", walkMinutes };
    // Best first: the fastest, unless one with fewer changes arrives at most CHANGE_PENALTY_S later.
    found.sort((a, b) => a.arrive.getTime() - b.arrive.getTime());
    let pick = 0;
    for (let j = 1; j < found.length; j++) {
      const late = (found[j].arrive.getTime() - found[0].arrive.getTime()) / 1000;
      if (found[j].rides < found[pick].rides && late <= CHANGE_PENALTY_S) pick = j;
    }
    if (pick > 0) found.unshift(...found.splice(pick, 1));
    return { journeys: found, walkMinutes };
  }

  private reconstruct(k: number, target: number, arrive: number, midnight: number): Journey {
    const net = this.net;
    const n = this.n;
    const at = (s: number) => new Date(midnight + s * 1000);
    const rev: Leg[] = [{ walk: true, fromStop: this.stop(target), minutes: minutesOf(this.egress[target]) }];
    let s = target;
    let firstDepart = 0;
    for (let j = k; j >= 1; j--) {
      const label = j * n + s;
      const from = this.tauFrom[label];
      if (from >= 0) {
        const sec = this.tau[label] - this.rideArr[j * n + from];
        rev.push({ walk: true, fromStop: this.stop(from), toStop: this.stop(s), minutes: minutesOf(sec) });
        s = from;
      }
      const ride = j * n + s;
      const r = this.rideRoute[ride];
      const trip = this.rideTrip[ride];
      const shift = this.rideDay[ride] * 1440;
      const b = this.rideBoard[ride];
      const a = this.rideAlight[ride];
      const start = net.routeStopStart[r];
      const time = (i: number) => (net.stopTimes[net.tripTimeStart[trip] + i] - shift) * 60;
      const path: [number, number][] = [];
      for (let i = b; i <= a; i++) {
        const st = net.routeStops[start + i];
        path.push([net.stopLon[st], net.stopLat[st]]);
      }
      const line = net.routeLine[r];
      const boardStop = net.routeStops[start + b];
      firstDepart = time(b);
      rev.push({
        walk: false,
        line: net.names.lines[line],
        mode: net.routeMode[r] as Mode,
        color: net.names.lineColors[line] ?? "",
        headsign: net.names.headsigns[net.tripHeadsign[trip]],
        fromStop: this.stop(boardStop),
        toStop: this.stop(s),
        depart: at(firstDepart),
        arrive: at(time(a)),
        stops: a - b,
        path,
      });
      s = boardStop;
    }
    rev.push({ walk: true, toStop: this.stop(s), minutes: minutesOf(this.access[s]) });
    // A footpath straight into the egress walk reads as one walk; a walk of zero minutes is no leg.
    const legs: Leg[] = [];
    for (let i = rev.length - 1; i >= 0; i--) {
      const leg = rev[i];
      if (leg.walk && leg.minutes === 0) continue;
      const last = legs[legs.length - 1];
      if (leg.walk && last?.walk) legs[legs.length - 1] = { walk: true, fromStop: last.fromStop, toStop: leg.toStop, minutes: last.minutes + leg.minutes };
      else legs.push(leg);
    }
    return { legs, leave: at(firstDepart - this.access[s]), arrive: at(Math.round(arrive / 60) * 60), rides: k, transfers: k - 1 };
  }

  /** The next n departures from a stop, soonest first; null when the timetable has expired. */
  nextDepartures(stopIndex: number, when: Date, n = 3): Departure[] | null {
    const net = this.net;
    const { ymd, seconds: now } = berlinClock(when);
    const day = daysBetween(net.baseDate, ymd);
    if (day < 0 || day >= WINDOW_DAYS || stopIndex < 0 || stopIndex >= this.n) return day < 0 || day >= WINDOW_DAYS ? null : [];
    const midnight = when.getTime() - (when.getTime() % 1000) - now * 1000;
    const found: { sec: number; r: number; trip: number }[] = [];
    for (let e = net.stopRouteStart[stopIndex]; e < net.stopRouteStart[stopIndex + 1]; e++) {
      const r = net.stopRouteRoute[e];
      const pos = net.stopRoutePos[e];
      if (pos >= net.routeLen[r] - 1) continue; // terminus: nothing departs
      const t0 = net.routeTripStart[r];
      for (let back = 0; back <= 1 && day - back >= 0; back++) {
        const bit = 1 << (day - back);
        for (let t = t0; t < t0 + net.routeTrips[r]; t++) {
          if (!(net.tripMask[t] & bit)) continue;
          const sec = (net.stopTimes[net.tripTimeStart[t] + pos] - back * 1440) * 60;
          if (sec >= now - (now % 60)) found.push({ sec, r, trip: t });
        }
      }
    }
    found.sort((a, b) => a.sec - b.sec);
    return found.slice(0, n).map(({ sec, r, trip }) => {
      const line = net.routeLine[r];
      return {
        line: net.names.lines[line],
        mode: net.routeMode[r] as Mode,
        color: net.names.lineColors[line] ?? "",
        headsign: net.names.headsigns[net.tripHeadsign[trip]],
        depart: new Date(midnight + sec * 1000),
        inMinutes: Math.max(0, Math.floor((sec - now) / 60)),
      };
    });
  }
}
