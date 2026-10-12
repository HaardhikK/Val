// The walking graph (built by scripts/build-map-data.py): decoding, nearest-node snapping and A*.
import { LocalProjection } from "./geo";

export interface WalkGraph {
  n: number;
  lat: Float64Array;
  lon: Float64Array;
  /** Projected metres (LocalProjection around the box centre), for costs and the heuristic. */
  x: Float32Array;
  y: Float32Array;
  offsets: Uint32Array;
  targets: Uint32Array;
  proj: LocalProjection;
}

const MAGIC = 0x31475743; // "CWG1" read as a little-endian u32

/** Decodes walk.graph (format documented in scripts/build-map-data.py). Throws on a malformed file. */
export function decodeGraph(buf: ArrayBuffer): WalkGraph {
  const dv = new DataView(buf);
  if (buf.byteLength < 32 || dv.getUint32(0, true) !== MAGIC) throw new Error("not a walk graph");
  const n = dv.getUint32(4, true);
  const m = dv.getUint32(8, true);
  const [minLat, minLon, maxLat, maxLon] = [12, 16, 20, 24].map((o) => dv.getFloat32(o, true));
  const offStart = 32 + 4 * n; // 2n u16 coordinates are always 4-byte aligned
  const tgtStart = offStart + 4 * (n + 1);
  if (buf.byteLength !== tgtStart + 4 * m) throw new Error("walk graph has the wrong size");
  const q = new Uint16Array(buf, 32, 2 * n);
  const offsets = new Uint32Array(buf, offStart, n + 1);
  const targets = new Uint32Array(buf, tgtStart, m);
  const proj = new LocalProjection((minLat + maxLat) / 2, (minLon + maxLon) / 2);
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lat[i] = minLat + (q[2 * i] / 65535) * (maxLat - minLat);
    lon[i] = minLon + (q[2 * i + 1] / 65535) * (maxLon - minLon);
    x[i] = proj.x(lon[i]);
    y[i] = proj.y(lat[i]);
  }
  return { n, lat, lon, x, y, offsets, targets, proj };
}

/** Builds a graph from plain arrays (tests, and anything that does not come from the file). */
export function graphFrom(points: [number, number][], edges: [number, number][]): WalkGraph {
  const n = points.length;
  const adj: number[][] = points.map(() => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const offsets = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + adj[i].length;
  const targets = Uint32Array.from(adj.flat());
  const lat = Float64Array.from(points.map((p) => p[0]));
  const lon = Float64Array.from(points.map((p) => p[1]));
  const proj = new LocalProjection(lat.reduce((a, b) => a + b, 0) / n, lon.reduce((a, b) => a + b, 0) / n);
  return {
    n,
    lat,
    lon,
    x: Float32Array.from(lon, (v) => proj.x(v)),
    y: Float32Array.from(lat, (v) => proj.y(v)),
    offsets,
    targets,
    proj,
  };
}

/** Uniform grid over the projected nodes, for "nearest walkable point to the GPS fix". */
export class SnapGrid {
  private readonly minX: number;
  private readonly minY: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly start: Uint32Array;
  private readonly items: Uint32Array;
  constructor(
    private readonly g: WalkGraph,
    private readonly cell = 100,
  ) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < g.n; i++) {
      minX = Math.min(minX, g.x[i]);
      maxX = Math.max(maxX, g.x[i]);
      minY = Math.min(minY, g.y[i]);
      maxY = Math.max(maxY, g.y[i]);
    }
    if (g.n === 0) minX = minY = maxX = maxY = 0;
    this.minX = minX;
    this.minY = minY;
    this.cols = Math.floor((maxX - minX) / cell) + 1;
    this.rows = Math.floor((maxY - minY) / cell) + 1;
    const count = new Uint32Array(this.cols * this.rows + 1);
    const cellOf = new Uint32Array(g.n);
    for (let i = 0; i < g.n; i++) {
      cellOf[i] = this.cellIndex(g.x[i], g.y[i]);
      count[cellOf[i] + 1]++;
    }
    for (let c = 1; c < count.length; c++) count[c] += count[c - 1];
    this.start = count;
    this.items = new Uint32Array(g.n);
    const fill = count.slice(0, -1);
    for (let i = 0; i < g.n; i++) this.items[fill[cellOf[i]]++] = i;
  }

  private cellIndex(x: number, y: number) {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
    return cy * this.cols + cx;
  }

  /** Nearest node within maxM metres of (lat, lon), or -1. */
  nearest(lat: number, lon: number, maxM = 400): number {
    const px = this.g.proj.x(lon);
    const py = this.g.proj.y(lat);
    const cx = Math.floor((px - this.minX) / this.cell);
    const cy = Math.floor((py - this.minY) / this.cell);
    let best = -1;
    let bestD2 = maxM * maxM;
    const maxRing = Math.ceil(maxM / this.cell) + 1;
    for (let r = 0; r <= maxRing; r++) {
      // Everything in ring r is at least (r - 1) cells away: stop once that beats the best so far.
      if (best >= 0 && ((r - 1) * this.cell) ** 2 > bestD2) break;
      for (let y = cy - r; y <= cy + r; y++) {
        if (y < 0 || y >= this.rows) continue;
        for (let x = cx - r; x <= cx + r; x++) {
          if (x < 0 || x >= this.cols) continue;
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue; // ring border only
          const c = y * this.cols + x;
          for (let k = this.start[c]; k < this.start[c + 1]; k++) {
            const i = this.items[k];
            const d2 = (this.g.x[i] - px) ** 2 + (this.g.y[i] - py) ** 2;
            if (d2 < bestD2) {
              bestD2 = d2;
              best = i;
            }
          }
        }
      }
    }
    return best;
  }
}

/** Binary min-heap of (priority, node), with typed arrays that grow on demand. */
export class MinHeap {
  private pri = new Float64Array(1024);
  private val = new Uint32Array(1024);
  size = 0;

  clear() {
    this.size = 0;
  }

  push(p: number, v: number) {
    if (this.size === this.pri.length) {
      const pri = new Float64Array(this.size * 2);
      pri.set(this.pri);
      this.pri = pri;
      const val = new Uint32Array(this.size * 2);
      val.set(this.val);
      this.val = val;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.pri[parent] <= p) break;
      this.pri[i] = this.pri[parent];
      this.val[i] = this.val[parent];
      i = parent;
    }
    this.pri[i] = p;
    this.val[i] = v;
  }

  /** Removes and returns the node with the lowest priority (call only when size > 0). */
  pop(): number {
    const top = this.val[0];
    const n = --this.size;
    const p = this.pri[n];
    const v = this.val[n];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && this.pri[child + 1] < this.pri[child]) child++;
      if (this.pri[child] >= p) break;
      this.pri[i] = this.pri[child];
      this.val[i] = this.val[child];
      i = child;
    }
    this.pri[i] = p;
    this.val[i] = v;
    return top;
  }
}

export interface Route {
  nodes: number[];
  /** Length along the path, metres. */
  meters: number;
}

/** A* over the graph; reuses its buffers between calls. */
export class Router {
  private readonly gScore: Float64Array;
  private readonly prev: Int32Array;
  private readonly seen: Uint32Array; // search stamp per node: avoids clearing arrays per query
  private readonly closed: Uint32Array;
  private stamp = 0;
  private readonly heap = new MinHeap();

  constructor(
    private readonly g: WalkGraph,
    private readonly maxExpansions = 600_000,
  ) {
    this.gScore = new Float64Array(g.n);
    this.prev = new Int32Array(g.n);
    this.seen = new Uint32Array(g.n);
    this.closed = new Uint32Array(g.n);
  }

  route(from: number, to: number): Route | null {
    const { g, gScore, prev, seen, closed, heap } = this;
    if (from < 0 || to < 0 || from >= g.n || to >= g.n) return null;
    const s = ++this.stamp;
    const tx = g.x[to], ty = g.y[to];
    const h = (i: number) => Math.hypot(g.x[i] - tx, g.y[i] - ty);
    heap.clear();
    gScore[from] = 0;
    prev[from] = -1;
    seen[from] = s;
    heap.push(h(from), from);
    let expanded = 0;
    while (heap.size > 0) {
      const u = heap.pop();
      if (closed[u] === s) continue; // stale heap entry
      closed[u] = s;
      if (u === to) return { nodes: this.path(to), meters: gScore[to] };
      if (++expanded > this.maxExpansions) return null;
      const gu = gScore[u];
      for (let k = g.offsets[u]; k < g.offsets[u + 1]; k++) {
        const v = g.targets[k];
        if (closed[v] === s) continue;
        const nd = gu + Math.hypot(g.x[v] - g.x[u], g.y[v] - g.y[u]);
        if (seen[v] !== s || nd < gScore[v]) {
          seen[v] = s;
          gScore[v] = nd;
          prev[v] = u;
          heap.push(nd + h(v), v);
        }
      }
    }
    return null;
  }

  private path(to: number): number[] {
    const out: number[] = [];
    for (let v = to; v !== -1; v = this.prev[v]) out.push(v);
    return out.reverse();
  }
}
