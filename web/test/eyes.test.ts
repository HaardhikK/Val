import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { anchorPose, connectedParts, findEyes, otherVertices, rayAnchor } from "../src/eyes";

/** A small square "eye" (two triangles, facing -y) centred at (cx, 0, cz), plus a thin "brow" bar above it. */
function face() {
  const pos: number[] = [];
  const index: number[] = [];
  const quad = (cx: number, cz: number, w: number, h: number, y: number) => {
    const b = pos.length / 3;
    pos.push(cx - w, y, cz - h, cx + w, y, cz - h, cx + w, y, cz + h, cx - w, y, cz + h);
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  // Eyes: each a 2×2 grid of quads (8 triangles), so they outnumber the 2-triangle brows.
  for (const cx of [-1, 1])
    for (const dx of [-0.25, 0.25]) for (const dz of [-0.25, 0.25]) quad(cx + dx, dz, 0.25, 0.25, -1);
  for (const cx of [-1, 1]) quad(cx, 1, 0.4, 0.05, -1);
  return { pos: new Float32Array(pos), index: new Uint16Array(index) };
}

test("the eyes are the two biggest parts, left to right; the brows are the rest", () => {
  const { pos, index } = face();
  // 2×2 quads per eye share edges by position only (no shared indices): still one part each.
  assert.equal(connectedParts(pos, index).length, 4);
  const eyes = findEyes(pos, index);
  assert.equal(eyes.length, 2);
  assert.equal(eyes[0].tris.length, 8);
  assert.ok(Math.abs(eyes[0].centre[0] + 1) < 1e-6 && Math.abs(eyes[1].centre[0] - 1) < 1e-6);
  assert.ok(Math.abs(eyes[0].radius - 0.5) < 1e-6);
  assert.equal(otherVertices(pos, index, eyes).length, 8); // the two brow quads
});

test("a ray from the front lands on the eye, and the anchor follows a morph", () => {
  const { pos, index } = face();
  const [, right] = findEyes(pos, index);
  const anchor = rayAnchor(pos, index, right.tris, [1.2, -5, 0.2], [0, 1, 0]);
  assert.ok(anchor);
  const p: [number, number, number] = [0, 0, 0];
  const n: [number, number, number] = [0, 0, 0];
  anchorPose(pos, [], [], anchor, p, n);
  assert.deepEqual(p.map((v) => +v.toFixed(5)), [1.2, -1, 0.2]);
  assert.deepEqual(n.map((v) => +v.toFixed(5)), [0, -1, 0]); // out of the face, towards the ray's origin
  // A morph that lifts every vertex by 0.3 in z, at half influence: the anchor rides along.
  const lift = new Float32Array(pos.length).map((_, i) => (i % 3 === 2 ? 0.3 : 0));
  anchorPose(pos, [lift], [0.5], anchor, p, n);
  assert.ok(Math.abs(p[2] - 0.35) < 1e-6);
  // A ray beside the eye misses it.
  assert.equal(rayAnchor(pos, index, right.tris, [3, -5, 0], [0, 1, 0]), null);
});

test("in the real model the black head mesh splits into two eye domes and two brows", () => {
  const buf = readFileSync("public/RobotExpressive.glb"); // npm test runs in web/
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
  const bin = buf.subarray(20 + jsonLen + 8);
  const read = (i: number) => {
    const a = gltf.accessors[i];
    const view = gltf.bufferViews[a.bufferView];
    const start = bin.byteOffset + (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const n = a.count * (a.type === "VEC3" ? 3 : 1);
    const copy = bin.buffer.slice(start, start + n * (a.componentType === 5126 ? 4 : 2));
    return a.componentType === 5126 ? new Float32Array(copy) : new Uint16Array(copy);
  };
  const head = gltf.meshes.find((m: { name: string }) => m.name === "Head");
  const black = head.primitives.find((p: { material: number }) => gltf.materials[p.material].name === "Black");
  const pos = read(black.attributes.POSITION);
  const index = read(black.indices);
  const eyes = findEyes(pos, index);
  assert.equal(eyes.length, 2);
  assert.equal(otherVertices(pos, index, eyes).length, 48); // two brows of 24 vertices
  // Mirror images of each other, with the brows above them (mesh +z is up).
  assert.ok(Math.abs(eyes[0].centre[0] + eyes[1].centre[0]) < 1e-4);
  assert.ok(Math.max(...otherVertices(pos, index, eyes).map((i) => pos[i * 3 + 2])) > eyes[0].centre[2] + eyes[0].radius);
  // From the front (mesh -y), a ray through the eye's middle hits it, facing out.
  const anchor = rayAnchor(pos, index, eyes[1].tris, [eyes[1].centre[0], -1, eyes[1].centre[2]], [0, 1, 0]);
  assert.ok(anchor);
  const p: [number, number, number] = [0, 0, 0];
  const n: [number, number, number] = [0, 0, 0];
  anchorPose(pos, [], [], anchor, p, n);
  assert.ok(n[1] < -0.9, `normal ${n}`);
});
