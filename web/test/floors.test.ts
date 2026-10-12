import { test } from "node:test";
import assert from "node:assert/strict";
import { FloorPicker, alongFloor, cornerFloor, uprightAngle, type Floor } from "../src/floors";
import { TRACES } from "../src/traces";

const floorsDuring = (name: string) => {
  const p = new FloorPicker();
  const seen: Floor[] = [];
  for (const s of TRACES[name]()) {
    const f = p.update(s.gravity, s.t);
    if (f) seen.push(f);
  }
  return seen;
};

test("a slight tilt never changes the floor", () => assert.deepEqual(floorsDuring("tiltRight"), []));
test("holding the phone sideways for only 3 s does not change the floor", () =>
  assert.deepEqual(floorsDuring("briefSide"), []));
test("tipping onto the left edge lands on the left floor, then back to the bottom", () =>
  assert.deepEqual(floorsDuring("leftSide"), ["left", "bottom"]));
test("tipping onto the right edge lands on the right floor, then back", () =>
  assert.deepEqual(floorsDuring("rightSide"), ["right", "bottom"]));
test("upside down makes the top edge the floor, and turning back flips it straight back", () =>
  assert.deepEqual(floorsDuring("upsideDown"), ["top", "bottom"]));
test("upside down falls within half a second, without the 5 s hold", () => {
  const p = new FloorPicker();
  const flipped: [number, number, number] = [0, -9.6, 1];
  assert.equal(p.update(flipped, 0), null);
  assert.equal(p.update(flipped, 300), "top");
});
test("a phone lying flat never switches floors", () => {
  const p = new FloorPicker();
  for (let t = 0; t < 2000; t += 20) assert.equal(p.update([3, -2, 9.3], t), null);
});
test("on the bottom floor, along-floor gravity equals sideways gravity", () =>
  assert.equal(alongFloor("bottom", [-4, 8, 1]), -4));
test("on the right floor, the floor runs up the screen", () => assert.equal(alongFloor("right", [0, 5, 0]), 5));
test("progress reports how far through the 5 s hold we are, and reset forgets it", () => {
  const p = new FloorPicker();
  const side: [number, number, number] = [9.7, 1, 1];
  p.update(side, 0);
  p.update(side, 2500);
  assert.ok(Math.abs(p.progress(2500) - 0.5) < 0.01);
  p.reset();
  assert.equal(p.progress(2600), 0);
  assert.equal(p.update(side, 5200), null); // the hold restarts after a reset
});

const deg = (r: number) => Math.round((r * 180) / Math.PI);
const tilted = (d: number): [number, number, number] => [-9.81 * Math.sin((d * Math.PI) / 180), 9.81 * Math.cos((d * Math.PI) / 180), 0];

test("upright phone: no turn needed", () => assert.equal(deg(uprightAngle("bottom", [0, 9.81, 0])), 0));
test("right edge 45° down: turns 45° counter-clockwise on screen to stay upright", () =>
  assert.equal(deg(uprightAngle("bottom", tilted(45))), 45));
test("left edge 45° down: turns 45° clockwise", () => assert.equal(deg(uprightAngle("bottom", tilted(-45))), -45));
test("standing on the left floor with the phone fully sideways: already upright", () =>
  assert.equal(deg(uprightAngle("left", [9.81, 0, 0])), 0));
test("standing on the left floor at only 45°: leans back 45° so it still looks upright", () =>
  assert.equal(deg(uprightAngle("left", tilted(-45))), 45));
test("a flat phone gives no turn", () => assert.equal(uprightAngle("bottom", [0.5, 0.5, 9.8]), 0));

test("each floor's corners lead to the right neighbours", () => {
  assert.equal(cornerFloor("bottom", 1), "right");
  assert.equal(cornerFloor("bottom", -1), "left");
  assert.equal(cornerFloor("right", 1), "top");
  assert.equal(cornerFloor("left", 1), "bottom");
});
test("already pressed into the right corner, it goes round after about 1.2 s instead of 5 s", () => {
  const p = new FloorPicker();
  const rightDown: [number, number, number] = [-9.5, 1.5, 1];
  assert.equal(p.update(rightDown, 0, "right"), null);
  assert.equal(p.update(rightDown, 1000, "right"), null);
  assert.equal(p.update(rightDown, 1300, "right"), "right");
});
