// Low-poly props Val pulls from behind his back before a feature opens: a chunky retro instant camera (camera) and a
// parchment scroll that unrolls into a little treasure map (map). A handful of boxes and cylinders each, toon-shaded
// like the robot (look.ts), built once and reused for every reveal. Sizes are in world units (Val is 2.5 tall).
import * as THREE from "three";
import { toonRamp } from "../look";
import type { PropKind } from "./timeline";

export interface FeatureProp {
  readonly kind: PropKind;
  readonly group: THREE.Group;
  /** 0..1 progress of the prop's own reveal action: the scroll's unroll (the camera has none). */
  setAction(k: number): void;
  /** Camera only: its flash fires, 1 → 0 over the burst (the glint sprite on the flash window). */
  flash?(k: number): void;
  /** A point (prop-local) Val looks at while holding it. */
  readonly gaze: THREE.Vector3;
}

const CREAM = 0xf4ead5;
const PINK = 0xffb3c8;
const CHARCOAL = 0x1a1a1a;
const SEPIA = 0xe9d9bf;
const WOOD = 0x8a7458;

let ramp: THREE.DataTexture | null = null;
const toon = (color: number) => new THREE.MeshToonMaterial({ color, gradientMap: (ramp ??= toonRamp()) });

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

/** A soft round glow (the flash glint), drawn once. */
function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 1, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,236,190,0.8)");
  grad.addColorStop(1, "rgba(255,176,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** The instant camera: cream body, black lens in a pink ring, a flash window, a strap. The lens faces +z. */
export function createInstantCamera(): FeatureProp {
  const group = new THREE.Group();
  group.name = "prop-camera";
  const cream = toon(CREAM);
  const dark = toon(CHARCOAL);
  const pink = toon(PINK);
  const W = 0.66;
  const H = 0.48;
  const D = 0.34;
  group.add(mesh(new THREE.BoxGeometry(W, H, D), cream));
  group.add(mesh(new THREE.BoxGeometry(W * 0.98, H * 0.16, D * 1.02), pink, 0, -H * 0.36, 0)); // a pink stripe
  group.add(mesh(new THREE.BoxGeometry(0.2, 0.1, 0.2), cream, -W * 0.28, H / 2 + 0.05, -0.02)); // viewfinder hump
  const ring = mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.05, 20), pink, 0.03, 0.02, D / 2 + 0.02);
  ring.rotation.x = Math.PI / 2;
  const lens = mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.12, 20), dark, 0.03, 0.02, D / 2 + 0.06);
  lens.rotation.x = Math.PI / 2;
  const shine = mesh(new THREE.CircleGeometry(0.035, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }), -0.02, 0.07, D / 2 + 0.125);
  group.add(ring, lens, shine);
  group.add(mesh(new THREE.BoxGeometry(0.15, 0.08, 0.02), new THREE.MeshBasicMaterial({ color: 0xffe7a8 }), W * 0.3, H * 0.3, D / 2 + 0.01)); // flash window
  // The strap loops back over the top: upright and dark, it drew a frown across Val's face behind the camera.
  const strap = mesh(new THREE.TorusGeometry(0.24, 0.025, 6, 16, Math.PI), pink, 0, H / 2 - 0.02, -D * 0.3);
  strap.rotation.x = -1.1;
  group.add(strap);
  const glint = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  glint.position.set(W * 0.3, H * 0.3, D / 2 + 0.08);
  glint.visible = false;
  group.add(glint);
  return {
    kind: "camera",
    group,
    gaze: new THREE.Vector3(0, 0, 0),
    setAction() {
      // The reveal only brings the camera round: no click, no glint.
    },
    flash(k) {
      // A photo: the flash window bursts bright and fades (k: 1 at the shutter, 0 when done).
      glint.visible = k > 0.01;
      glint.scale.setScalar(0.4 + 1.2 * k);
    },
  };
}

/** The little treasure map drawn on the sheet: a dotted pink trail to an X. */
function mapTexture() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 104;
  const g = c.getContext("2d")!;
  g.fillStyle = "#e9d9bf";
  g.fillRect(0, 0, 128, 104);
  g.strokeStyle = "rgba(138,116,88,.35)";
  g.lineWidth = 1.5;
  for (const y of [26, 62, 88]) {
    g.beginPath();
    g.moveTo(6, y);
    g.bezierCurveTo(40, y - 12, 80, y + 12, 122, y - 4);
    g.stroke();
  }
  g.strokeStyle = "#ffb3c8";
  g.lineWidth = 5;
  g.lineCap = "round";
  g.setLineDash([0.5, 9]);
  g.beginPath();
  g.moveTo(16, 92);
  g.bezierCurveTo(40, 60, 30, 50, 62, 52);
  g.bezierCurveTo(96, 54, 70, 26, 102, 22);
  g.stroke();
  g.setLineDash([]);
  g.strokeStyle = "#5a4630";
  g.lineWidth = 6;
  g.lineCap = "square";
  g.beginPath();
  g.moveTo(100, 12);
  g.lineTo(114, 26);
  g.moveTo(114, 12);
  g.lineTo(100, 26);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The scroll: a parchment roll (along x) whose sheet unrolls downwards (facing +z) with a second rod at its edge. */
export function createScroll(): FeatureProp {
  const group = new THREE.Group();
  group.name = "prop-scroll";
  const paper = toon(SEPIA);
  const wood = toon(WOOD);
  const LEN = 0.86;
  const SHEET_H = 0.7;
  const roll = new THREE.CylinderGeometry(0.075, 0.075, LEN, 12);
  const cap = new THREE.CylinderGeometry(0.095, 0.095, 0.06, 12);
  const rod = (y: number) => {
    const r = new THREE.Group();
    const body = mesh(roll, paper);
    body.rotation.z = Math.PI / 2;
    const left = mesh(cap, wood, -LEN / 2 - 0.03, 0, 0);
    const right = mesh(cap, wood, LEN / 2 + 0.03, 0, 0);
    left.rotation.z = right.rotation.z = Math.PI / 2;
    r.add(body, left, right);
    r.position.y = y;
    return r;
  };
  const top = rod(0);
  const bottom = rod(0);
  bottom.scale.setScalar(0.85);
  const sheetGeo = new THREE.PlaneGeometry(LEN * 0.94, SHEET_H);
  sheetGeo.translate(0, -SHEET_H / 2, 0); // hangs from the top rod
  const sheet = mesh(sheetGeo, new THREE.MeshBasicMaterial({ map: mapTexture(), side: THREE.DoubleSide }), 0, 0, 0.02);
  sheet.scale.y = 0.001;
  group.add(top, sheet, bottom);
  const gaze = new THREE.Vector3(0, -SHEET_H / 2, 0);
  return {
    kind: "scroll",
    group,
    gaze,
    setAction(k) {
      const e = 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 2);
      sheet.scale.y = Math.max(0.001, e);
      sheet.visible = e > 0.01;
      bottom.position.y = -SHEET_H * e;
      bottom.rotation.x = -e * 8; // the roll turns as it unwinds
    },
  };
}
