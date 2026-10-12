// Small geodesy helpers: distances for people (haversine) and a flat local projection for routing.

const R = 6_371_008.8; // mean Earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, degrees clockwise from north (0..360). */
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x =
    Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Equirectangular projection around a reference point, in metres. Over a city (30 km) the error is well
 * under 1 %, and edge costs and the A* heuristic use the same metric, so the heuristic stays admissible.
 */
export class LocalProjection {
  private readonly ky = (Math.PI / 180) * R;
  private readonly kx: number;
  constructor(
    readonly lat0: number,
    readonly lon0: number,
  ) {
    this.kx = this.ky * Math.cos(rad(lat0));
  }
  x(lon: number) {
    return (lon - this.lon0) * this.kx;
  }
  y(lat: number) {
    return (lat - this.lat0) * this.ky;
  }
}

type LonLat = [number, number];
const dist = (a: LonLat, b: LonLat) => haversine(a[1], a[0], b[1], b[0]);

/**
 * A route is [start, ...graph nodes, end]. When the nearest graph node lies past the start or the end, the
 * line runs out to it and doubles back, a visible hook. Join the start (and the end) straight to a later
 * node within `reachM` when the skipped stretch is a hook (at least twice the straight hop), never to cut
 * an ordinary corner through a building.
 */
export function trimHooks(path: LonLat[], reachM = 80): LonLat[] {
  if (path.length < 4) return path.slice();
  const cut = (p: LonLat[]) => {
    // Best node k to join p[0] to: minimise the straight hop plus the rest of the path from k.
    const rest: number[] = new Array(p.length).fill(0);
    for (let i = p.length - 2; i >= 0; i--) rest[i] = rest[i + 1] + dist(p[i], p[i + 1]);
    let best = 1;
    let bestCost = Infinity;
    for (let k = 1; k < p.length - 1; k++) {
      const hop = dist(p[0], p[k]);
      if (k > 1 && (hop > reachM || rest[0] - rest[k] < 2 * hop)) continue;
      const cost = hop + rest[k];
      if (cost < bestCost - 0.01) {
        best = k;
        bestCost = cost;
      }
    }
    return [p[0], ...p.slice(best)];
  };
  return cut(cut(path).reverse()).reverse();
}

/** Length of a [lon, lat] polyline in metres. */
export function pathLength(path: LonLat[]): number {
  let m = 0;
  for (let i = 1; i < path.length; i++) m += dist(path[i - 1], path[i]);
  return m;
}

/** "350 m", "1.2 km". */
export function formatDistance(m: number): string {
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 9950 ? 1 : 0)} km`;
}

/** Walking time at 4.8 km/h: "6 min walk", "3 h 15 min walk". */
export function formatWalk(m: number): string {
  const min = Math.max(1, Math.round(m / 80));
  return min < 60 ? `${min} min walk` : `${Math.floor(min / 60)} h ${min % 60} min walk`;
}

/** Satellites the GPS chip hears (the app's `sky` message, about once a second while GPS is on). */
export interface Sky {
  total: number;
  used: number;
  best: number;
}

/** The no-fix strip's words: "Looking for satellites: 5 seen, 0 locked" once the chip hears any. */
export function gpsStatusText(gpsOff: boolean, hadFix: boolean, sky: Sky | null): string {
  if (gpsOff) return "Turn on location";
  if (sky && sky.total > 0) return `Looking for satellites: ${sky.total} seen, ${sky.used} locked`;
  return hadFix ? "Lost the sky · step outside" : "Finding you · step outside";
}
