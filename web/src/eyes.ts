// Finding Val's eyes in the head mesh and pinning the eye highlights onto their surface. Pure geometry on flat
// arrays (no scene graph), so it is unit-tested. In RobotExpressive the eyes and the eyebrows share one mesh and one
// material ("Black"): the eyes are the two big domes, the brows two thin bars of a few vertices each.

type Vec3 = [number, number, number];

/** A point on a triangle of the mesh: its three vertex indices and barycentric weights for b and c. */
export interface SurfaceAnchor {
  a: number;
  b: number;
  c: number;
  u: number;
  v: number;
}

export interface Eye {
  /** Triangle indices (into the index buffer, /3) of this eye. */
  tris: number[];
  /** Centre of the eye's bounding box (mesh-local). */
  centre: Vec3;
  /** Half the largest side of its bounding box. */
  radius: number;
}

const get = (pos: ArrayLike<number>, i: number): Vec3 => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];

/**
 * Split a mesh into connected parts: vertices joined by a triangle, or sitting at the same position (glTF splits
 * vertices at hard edges). Returns each part's triangle indices.
 */
export function connectedParts(pos: ArrayLike<number>, index: ArrayLike<number>): number[][] {
  const n = pos.length / 3;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const join = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (let t = 0; t < index.length; t += 3) {
    join(index[t], index[t + 1]);
    join(index[t], index[t + 2]);
  }
  const seen = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const key = `${pos[i * 3].toFixed(6)},${pos[i * 3 + 1].toFixed(6)},${pos[i * 3 + 2].toFixed(6)}`;
    const other = seen.get(key);
    if (other === undefined) seen.set(key, i);
    else join(i, other);
  }
  const parts = new Map<number, number[]>();
  for (let t = 0; t < index.length / 3; t++) {
    const root = find(index[t * 3]);
    if (!parts.has(root)) parts.set(root, []);
    parts.get(root)!.push(t);
  }
  return [...parts.values()];
}

/** The two eyes: the two parts with the most triangles (the brows are thin bars), ordered by x. */
export function findEyes(pos: ArrayLike<number>, index: ArrayLike<number>): Eye[] {
  const parts = connectedParts(pos, index).sort((p, q) => q.length - p.length);
  if (parts.length < 2) return [];
  const eyes = parts.slice(0, 2).map((tris) => {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const t of tris)
      for (let k = 0; k < 3; k++) {
        const p = get(pos, index[t * 3 + k]);
        for (let j = 0; j < 3; j++) {
          min[j] = Math.min(min[j], p[j]);
          max[j] = Math.max(max[j], p[j]);
        }
      }
    const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const radius = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
    return { tris, centre, radius };
  });
  return eyes.sort((p, q) => p.centre[0] - q.centre[0]);
}

/** Vertices used by no eye triangle (the brows). */
export function otherVertices(pos: ArrayLike<number>, index: ArrayLike<number>, eyes: Eye[]): number[] {
  const inEye = new Set<number>();
  for (const eye of eyes) for (const t of eye.tris) for (let k = 0; k < 3; k++) inEye.add(index[t * 3 + k]);
  const out: number[] = [];
  for (let i = 0; i < pos.length / 3; i++) if (!inEye.has(i)) out.push(i);
  return out;
}

/** Nearest triangle of `tris` hit by the ray origin + t·dir (t > 0), as a surface anchor; null if it misses. */
export function rayAnchor(pos: ArrayLike<number>, index: ArrayLike<number>, tris: number[], origin: Vec3, dir: Vec3): SurfaceAnchor | null {
  let best: SurfaceAnchor | null = null;
  let bestT = Infinity;
  for (const t of tris) {
    const a = index[t * 3];
    const b = index[t * 3 + 1];
    const c = index[t * 3 + 2];
    const A = get(pos, a);
    const e1 = sub(get(pos, b), A);
    const e2 = sub(get(pos, c), A);
    const p = cross(dir, e2);
    const det = dot(e1, p);
    if (Math.abs(det) < 1e-14) continue;
    const s = sub(origin, A);
    const u = dot(s, p) / det;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1);
    const v = dot(dir, q) / det;
    if (v < 0 || u + v > 1) continue;
    const dist = dot(e2, q) / det;
    if (dist > 0 && dist < bestT) {
      bestT = dist;
      // Keep the winding facing the ray's origin (det > 0), so the anchor's face normal points out of the eye.
      best = det > 0 ? { a, b, c, u, v } : { a, b: c, c: b, u: v, v: u };
    }
  }
  return best;
}

const _A: Vec3 = [0, 0, 0];
const _B: Vec3 = [0, 0, 0];
const _C: Vec3 = [0, 0, 0];

function corner(pos: ArrayLike<number>, morphs: ArrayLike<number>[], influences: ArrayLike<number>, i: number, p: Vec3) {
  p[0] = pos[i * 3];
  p[1] = pos[i * 3 + 1];
  p[2] = pos[i * 3 + 2];
  for (let m = 0; m < morphs.length; m++) {
    const w = influences[m] ?? 0;
    if (w === 0) continue;
    p[0] += w * morphs[m][i * 3];
    p[1] += w * morphs[m][i * 3 + 1];
    p[2] += w * morphs[m][i * 3 + 2];
  }
}

/**
 * The anchor's current position and outward face normal, with the mesh's morph targets applied (glTF morphs are
 * relative: base + sum of influence * delta). Writes into `out` and `normal`; no allocation (it runs every frame).
 */
export function anchorPose(
  pos: ArrayLike<number>,
  morphs: ArrayLike<number>[],
  influences: ArrayLike<number>,
  anchor: SurfaceAnchor,
  out: Vec3,
  normal: Vec3,
) {
  corner(pos, morphs, influences, anchor.a, _A);
  corner(pos, morphs, influences, anchor.b, _B);
  corner(pos, morphs, influences, anchor.c, _C);
  const wa = 1 - anchor.u - anchor.v;
  for (let j = 0; j < 3; j++) out[j] = wa * _A[j] + anchor.u * _B[j] + anchor.v * _C[j];
  // (B - A) x (C - A), into the scratch _B and _C.
  for (let j = 0; j < 3; j++) {
    _B[j] -= _A[j];
    _C[j] -= _A[j];
  }
  normal[0] = _B[1] * _C[2] - _B[2] * _C[1];
  normal[1] = _B[2] * _C[0] - _B[0] * _C[2];
  normal[2] = _B[0] * _C[1] - _B[1] * _C[0];
  const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  normal[0] /= len;
  normal[1] /= len;
  normal[2] /= len;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
