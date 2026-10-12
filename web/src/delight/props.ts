// Tiny props for the light reactions: sunglasses (bright sun) and a lantern glow (dark room).
// Unlit materials and one shared sprite texture: no lights added to the scene (that would recompile every shader).
import * as THREE from "three";

/**
 * Round dark shades: two lenses `spacing` apart (world units: the distance between the eyes) and a bridge. Built with
 * its back at z = 0 so it sits flat against the front of the bulging eyes (EyeShine.seat), depth-tested like the
 * rest of the robot; each lens is a little wider than an eye.
 */
export function createSunglasses(spacing = 0.9) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x0a0a0f });
  const depth = 0.04;
  const r = spacing * 0.34;
  const lens = new THREE.CylinderGeometry(r, r, depth, 20);
  lens.rotateX(Math.PI / 2);
  for (const side of [-1, 1]) {
    const m = new THREE.Mesh(lens, mat);
    m.position.set((side * spacing) / 2, 0, depth / 2);
    g.add(m);
  }
  const gap = spacing - 2 * r;
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(gap + r * 0.4, r * 0.22, depth * 0.6), mat);
  bridge.position.set(0, r * 0.45, depth * 0.3);
  g.add(bridge);
  const glint = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false });
  const shine = new THREE.Mesh(new THREE.PlaneGeometry(r * 0.22, r * 0.9), glint);
  shine.position.set(-spacing / 2 - r * 0.35, r * 0.2, depth + 0.004);
  shine.rotation.z = -0.6;
  g.add(shine);
  g.visible = false;
  g.name = "sunglasses";
  return g;
}

/** A warm additive glow sprite with a small bright core. */
export function createLantern(size = 0.9) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 1, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,236,200,0.95)");
  grad.addColorStop(0.18, "rgba(255,190,120,0.55)");
  grad.addColorStop(1, "rgba(255,150,90,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  sprite.scale.setScalar(size);
  sprite.visible = false;
  sprite.name = "lantern";
  return sprite;
}
