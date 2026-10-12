// The look: pastel pink cartoon (toon) shading, cream trim, a bigger chibi head,
// and small eye highlights pinned onto the eye surface (eyes.ts).
import * as THREE from "three";
import { anchorPose, findEyes, otherVertices, rayAnchor, type SurfaceAnchor } from "./eyes";

const PALETTE: Record<string, number> = {
  Main: 0xffb3c8, // soft pink body
  Grey: 0xfff1e4, // cream trim
  Black: 0x2b2340, // deep plum eyes
};

const HEAD_SCALE = 1.22;

/** A 3-step light ramp: flat, friendly cartoon shading. */
export function toonRamp() {
  const tex = new THREE.DataTexture(new Uint8Array([90, 175, 255]), 3, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/** The eye highlights: drawn on the eye surface, following the head and the face morphs. Call update() per frame. */
export interface EyeShine {
  readonly dots: THREE.Mesh[];
  update(): void;
  /** Distance between the eye centres, in world units. */
  readonly spacing: number;
  /**
   * Seat a prop built in world units (centred between the eyes, +z out of the face, its back at z = 0) against the
   * front of the eyes, so it rides on the head (sunglasses).
   */
  seat(prop: THREE.Object3D): void;
}

// Where the highlights sit on each eye, in eye radii from its middle as seen from the front: a big one up and to the
// right (where the key light is), a small one down and to the left. The same on both eyes, like a cartoon.
const SHINE = [
  { right: 0.32, up: 0.36, size: 0.2 },
  { right: -0.3, up: -0.34, size: 0.09 },
];
/** Lifted off the eye surface by this fraction of the eye radius (just enough to never z-fight). */
const SHINE_LIFT = 0.03;

/** Apply the pink look to a freshly loaded model (before it is animated). Returns the eye highlights. */
export function applyPinkLook(model: THREE.Object3D): EyeShine | null {
  const ramp = toonRamp();
  const byName = new Map<string, THREE.Material>();
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const swap = (m: THREE.Material) => {
      const src = m as THREE.MeshStandardMaterial;
      if (!byName.has(src.name)) {
        byName.set(src.name, new THREE.MeshToonMaterial({ name: src.name, color: PALETTE[src.name] ?? src.color?.getHex() ?? 0xffffff, gradientMap: ramp }));
      }
      return byName.get(src.name)!;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });

  const head = model.getObjectByName("Head");
  if (!head) return null;
  head.scale.setScalar(HEAD_SCALE);
  return eyeShine(model, head);
}

/**
 * The eyes are the black part of the head mesh (together with the brows): find the two eye domes in its geometry and
 * pin each highlight onto the dome's surface, so it stays on the eye from any side and moves with the expressions.
 */
function eyeShine(model: THREE.Object3D, head: THREE.Object3D): EyeShine | null {
  const found: THREE.Mesh[] = [];
  head.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && (m.material as THREE.Material).name === "Black") found.push(m);
  });
  const black = found[0];
  if (!black) return null;
  const geo = black.geometry;
  const pos = geo.attributes.position?.array;
  const index = geo.index?.array;
  if (!pos || !index) return null;
  const eyes = findEyes(pos, index);
  if (eyes.length !== 2) return null;

  // The viewer's right, up and forward (towards the camera) at rest, in the mesh's own frame.
  model.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4().copy(black.matrixWorld).invert();
  const right = new THREE.Vector3(1, 0, 0).transformDirection(toLocal);
  const up = new THREE.Vector3(0, 1, 0).transformDirection(toLocal);
  const forward = new THREE.Vector3(0, 0, 1).transformDirection(toLocal);
  const back = forward.clone().negate().toArray();
  const brows = otherVertices(pos, index, eyes);
  pullInBrows(black, brows, eyes, right, forward);
  tameSurprisedBrows(black, brows, forward);
  const morphs = (geo.morphAttributes.position ?? []).map((a) => a.array);
  const influences = black.morphTargetInfluences ?? [];

  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const placed: { dot: THREE.Mesh; anchor: SurfaceAnchor; lift: number }[] = [];
  for (const eye of eyes) {
    for (const s of SHINE) {
      const aim = new THREE.Vector3(...eye.centre).addScaledVector(right, s.right * eye.radius).addScaledVector(up, s.up * eye.radius);
      const origin = aim.addScaledVector(forward, eye.radius * 10).toArray();
      const anchor = rayAnchor(pos, index, eye.tris, origin, back);
      if (!anchor) continue;
      const dot = new THREE.Mesh(new THREE.CircleGeometry(s.size * eye.radius, 12), material);
      dot.name = "eye-shine";
      black.add(dot);
      placed.push({ dot, anchor, lift: SHINE_LIFT * eye.radius });
    }
  }
  const p: [number, number, number] = [0, 0, 0];
  const n: [number, number, number] = [0, 0, 0];
  const normal = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1);
  const update = () => {
    for (const { dot, anchor, lift } of placed) {
      anchorPose(pos, morphs, influences, anchor, p, n);
      normal.set(n[0], n[1], n[2]);
      dot.position.set(p[0], p[1], p[2]).addScaledVector(normal, lift);
      dot.quaternion.setFromUnitVectors(Z, normal);
    }
  };
  update();

  // The front of the eyes: midway between their centres, as far out as the furthest eye surface reaches.
  const mid = new THREE.Vector3(...eyes[0].centre).add(new THREE.Vector3(...eyes[1].centre)).multiplyScalar(0.5);
  let front = -Infinity;
  for (const eye of eyes)
    for (const t of eye.tris)
      for (let k = 0; k < 3; k++) {
        const i = index[t * 3 + k];
        front = Math.max(front, pos[i * 3] * forward.x + pos[i * 3 + 1] * forward.y + pos[i * 3 + 2] * forward.z);
      }
  const seatAt = mid.clone().addScaledVector(forward, front - mid.dot(forward));
  const seatTurn = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, forward));
  const worldScale = black.getWorldScale(new THREE.Vector3()).x;
  const spacing = new THREE.Vector3(...eyes[0].centre).distanceTo(new THREE.Vector3(...eyes[1].centre)) * worldScale;
  const seat = (prop: THREE.Object3D) => {
    prop.position.copy(seatAt);
    prop.quaternion.copy(seatTurn);
    prop.scale.divideScalar(worldScale);
    black.add(prop);
  };
  return { dots: placed.map((d) => d.dot), update, spacing, seat };
}

/** The brows' outer ends reach the dome's outline (and poke past it seen from aside): narrow them a little and sit
 * them a little further back. Only brow vertices move, so the eye highlights (anchored on eye triangles) are untouched. */
const BROW_NARROW = 0.88;
const BROW_BACK = 0.12; // in eye radii

function pullInBrows(mesh: THREE.Mesh, brows: number[], eyes: { centre: readonly number[]; radius: number }[], right: THREE.Vector3, forward: THREE.Vector3) {
  const attr = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const mid = new THREE.Vector3(...eyes[0].centre).add(new THREE.Vector3(...eyes[1].centre)).multiplyScalar(0.5);
  const back = BROW_BACK * eyes[0].radius;
  const v = new THREE.Vector3();
  for (const i of brows) {
    v.fromBufferAttribute(attr, i);
    const along = v.clone().sub(mid).dot(right);
    v.addScaledVector(right, -along * (1 - BROW_NARROW)).addScaledVector(forward, -back);
    attr.setXYZ(i, v.x, v.y, v.z);
  }
  attr.needsUpdate = true;
}

/** How much of the model's own brow lift the surprised face keeps, and how far the brows tuck back meanwhile. */
const BROW_LIFT = 0.4;
const BROW_TUCK = 0.5;

/**
 * The model's surprised face lifts the brows straight up, clear of the bigger head, so they float in the air above
 * it. Keep a smaller lift and slide them back over the curve of the head instead, so they stay on the forehead.
 */
function tameSurprisedBrows(mesh: THREE.Mesh, brows: number[], forward: THREE.Vector3) {
  const k = mesh.morphTargetDictionary?.Surprised;
  const attr = k === undefined ? undefined : mesh.geometry.morphAttributes.position?.[k];
  if (!attr) return;
  const d = new THREE.Vector3();
  for (const i of brows) {
    d.fromBufferAttribute(attr, i);
    const lift = d.length();
    d.multiplyScalar(BROW_LIFT).addScaledVector(forward, -BROW_TUCK * lift);
    attr.setXYZ(i, d.x, d.y, d.z);
  }
  attr.needsUpdate = true;
}
