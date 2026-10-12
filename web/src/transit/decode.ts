// The offline timetable (transit.bin + transit-stops.json, built from the Dresden GTFS): decoding.
//
// transit.bin, little-endian, packed with no padding (so every field is read through a DataView):
//   header      "CHTR", u16 version = 1, u32 baseDate (YYYYMMDD),
//               u32 nStops, nRoutes, nTrips, nStopTimes, nTransfers
//   stops       nStops × (f32 lat, f32 lon)
//   routes      nRoutes × (u16 lineIndex, u8 mode, u16 nStopsInRoute, u32 firstRouteStopOffset,
//                          u32 firstTripOffset, u16 nTrips)
//   routeStops  u32 stop indices, flat
//   trips       nTrips × (u16 dayMask, u16 headsignIndex, u32 firstStopTimeOffset), sorted by first
//               departure within each route; dayMask bit d = runs on baseDate + d days (14 days)
//   stopTimes   u16 minutes after the service day's midnight (> 1440 after midnight), one per route stop
//               per trip
//   transfers   nTransfers × (u32 from, u32 to, u16 walkSeconds)
//   stopRoutes  nStops + 1 u32 offsets, then pairs (u32 routeIndex, u16 posInRoute)

/** 0 tram, 1 bus, 2 rail, 3 ferry, 4 other. */
export type Mode = 0 | 1 | 2 | 3 | 4;

export interface TransitNames {
  stops: string[];
  lines: string[];
  headsigns: string[];
  lineColors: string[];
}

export interface Transit {
  version: number;
  /** YYYYMMDD of day 0 of the 14-day day masks. */
  baseDate: number;
  nStops: number;
  nRoutes: number;
  nTrips: number;
  stopLat: Float64Array;
  stopLon: Float64Array;
  routeLine: Uint16Array;
  routeMode: Uint8Array;
  routeLen: Uint16Array;
  routeStopStart: Uint32Array;
  routeTripStart: Uint32Array;
  routeTrips: Uint16Array;
  routeStops: Uint32Array;
  tripMask: Uint16Array;
  tripHeadsign: Uint16Array;
  tripTimeStart: Uint32Array;
  stopTimes: Uint16Array;
  transferStart: Uint32Array; // nStops + 1 offsets into transferTo/transferSec, grouped by "from"
  transferTo: Uint32Array;
  transferSec: Uint16Array;
  stopRouteStart: Uint32Array;
  stopRouteRoute: Uint32Array;
  stopRoutePos: Uint16Array;
  names: TransitNames;
}

const HEADER = 30;
const ROUTE = 15;
const TRIP = 8;
const TRANSFER = 10;
const STOP_ROUTE = 6;

/** Decodes transit.bin with its names. Throws on a malformed file, so a bad pack fails loudly at load. */
export function decodeTransit(buf: ArrayBuffer, names: TransitNames): Transit {
  const dv = new DataView(buf);
  const fail = (why: string): never => {
    throw new Error(`transit.bin: ${why}`);
  };
  if (buf.byteLength < HEADER) fail("too short");
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "CHTR") fail("not a timetable");
  const version = dv.getUint16(4, true);
  if (version !== 1) fail(`unsupported version ${version}`);
  const baseDate = dv.getUint32(6, true);
  const nStops = dv.getUint32(10, true);
  const nRoutes = dv.getUint32(14, true);
  const nTrips = dv.getUint32(18, true);
  const nStopTimes = dv.getUint32(22, true);
  const nTransfers = dv.getUint32(26, true);

  let o = HEADER;
  const oStops = o;
  o += 8 * nStops;
  const oRoutes = o;
  o += ROUTE * nRoutes;
  const oRouteStops = o;
  // The routeStops length is the sum of the route lengths, so read the routes before going further.
  if (buf.byteLength < o) fail("truncated routes");
  const routeLine = new Uint16Array(nRoutes);
  const routeMode = new Uint8Array(nRoutes);
  const routeLen = new Uint16Array(nRoutes);
  const routeStopStart = new Uint32Array(nRoutes);
  const routeTripStart = new Uint32Array(nRoutes);
  const routeTrips = new Uint16Array(nRoutes);
  let nRouteStops = 0;
  for (let r = 0, p = oRoutes; r < nRoutes; r++, p += ROUTE) {
    routeLine[r] = dv.getUint16(p, true);
    routeMode[r] = dv.getUint8(p + 2);
    routeLen[r] = dv.getUint16(p + 3, true);
    routeStopStart[r] = dv.getUint32(p + 5, true);
    routeTripStart[r] = dv.getUint32(p + 9, true);
    routeTrips[r] = dv.getUint16(p + 13, true);
    nRouteStops = Math.max(nRouteStops, routeStopStart[r] + routeLen[r]);
  }
  o += 4 * nRouteStops;
  const oTrips = o;
  o += TRIP * nTrips;
  const oStopTimes = o;
  o += 2 * nStopTimes;
  const oTransfers = o;
  o += TRANSFER * nTransfers;
  const oStopRouteOffsets = o;
  o += 4 * (nStops + 1);
  if (buf.byteLength < o) fail("truncated");
  const nStopRoutes = dv.getUint32(oStopRouteOffsets + 4 * nStops, true);
  const oStopRoutes = o;
  o += STOP_ROUTE * nStopRoutes;
  if (buf.byteLength !== o) fail(`wrong size (${buf.byteLength} bytes, expected ${o})`);

  const stopLat = new Float64Array(nStops);
  const stopLon = new Float64Array(nStops);
  for (let i = 0, p = oStops; i < nStops; i++, p += 8) {
    stopLat[i] = dv.getFloat32(p, true);
    stopLon[i] = dv.getFloat32(p + 4, true);
  }
  const routeStops = new Uint32Array(nRouteStops);
  for (let i = 0, p = oRouteStops; i < nRouteStops; i++, p += 4) routeStops[i] = dv.getUint32(p, true);
  const tripMask = new Uint16Array(nTrips);
  const tripHeadsign = new Uint16Array(nTrips);
  const tripTimeStart = new Uint32Array(nTrips);
  for (let t = 0, p = oTrips; t < nTrips; t++, p += TRIP) {
    tripMask[t] = dv.getUint16(p, true);
    tripHeadsign[t] = dv.getUint16(p + 2, true);
    tripTimeStart[t] = dv.getUint32(p + 4, true);
  }
  const stopTimes = new Uint16Array(nStopTimes);
  for (let i = 0, p = oStopTimes; i < nStopTimes; i++, p += 2) stopTimes[i] = dv.getUint16(p, true);

  // Transfers are regrouped by "from" stop (CSR), so a round can walk a stop's footpaths directly.
  const transferStart = new Uint32Array(nStops + 1);
  const tFrom = new Uint32Array(nTransfers);
  for (let i = 0, p = oTransfers; i < nTransfers; i++, p += TRANSFER) {
    tFrom[i] = dv.getUint32(p, true);
    if (tFrom[i] >= nStops) fail(`transfer ${i} from an unknown stop`);
    transferStart[tFrom[i] + 1]++;
  }
  for (let s = 0; s < nStops; s++) transferStart[s + 1] += transferStart[s];
  const fill = transferStart.slice(0, nStops);
  const transferTo = new Uint32Array(nTransfers);
  const transferSec = new Uint16Array(nTransfers);
  for (let i = 0, p = oTransfers; i < nTransfers; i++, p += TRANSFER) {
    const at = fill[tFrom[i]]++;
    transferTo[at] = dv.getUint32(p + 4, true);
    transferSec[at] = dv.getUint16(p + 8, true);
    if (transferTo[at] >= nStops) fail(`transfer ${i} to an unknown stop`);
  }

  const stopRouteStart = new Uint32Array(nStops + 1);
  for (let s = 0; s <= nStops; s++) stopRouteStart[s] = dv.getUint32(oStopRouteOffsets + 4 * s, true);
  const stopRouteRoute = new Uint32Array(nStopRoutes);
  const stopRoutePos = new Uint16Array(nStopRoutes);
  for (let i = 0, p = oStopRoutes; i < nStopRoutes; i++, p += STOP_ROUTE) {
    stopRouteRoute[i] = dv.getUint32(p, true);
    stopRoutePos[i] = dv.getUint16(p + 4, true);
  }

  // Cross-checks, so a bad index fails here instead of as a silent wrong answer mid-query.
  for (let r = 0; r < nRoutes; r++) {
    const trips = routeTripStart[r] + routeTrips[r];
    if (trips > nTrips) fail(`route ${r} points past the trips`);
    if (routeTrips[r] > 0 && tripTimeStart[trips - 1] + routeLen[r] > nStopTimes) fail(`route ${r} points past the stop times`);
    if (routeLine[r] >= names.lines.length) fail(`route ${r} has an unknown line`);
  }
  for (const s of routeStops) if (s >= nStops) fail("route stop out of range");
  for (const h of tripHeadsign) if (h >= names.headsigns.length) fail("unknown headsign");
  for (let i = 0; i < nStopRoutes; i++) {
    const r = stopRouteRoute[i];
    if (r >= nRoutes || stopRoutePos[i] >= routeLen[r]) fail("stop route out of range");
  }
  if (names.stops.length !== nStops) fail("names do not match the stops");

  return {
    version,
    baseDate,
    nStops,
    nRoutes,
    nTrips,
    stopLat,
    stopLon,
    routeLine,
    routeMode,
    routeLen,
    routeStopStart,
    routeTripStart,
    routeTrips,
    routeStops,
    tripMask,
    tripHeadsign,
    tripTimeStart,
    stopTimes,
    transferStart,
    transferTo,
    transferSec,
    stopRouteStart,
    stopRouteRoute,
    stopRoutePos,
    names,
  };
}
