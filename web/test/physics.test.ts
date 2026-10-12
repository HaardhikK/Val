import { test } from "node:test";
import assert from "node:assert/strict";
import { FLOOR_HALF_WIDTH, restingBody, step } from "../src/physics";

const simulate = (gravityX: number, seconds: number) => {
  let b = restingBody();
  let bumped = false;
  for (let t = 0; t < seconds; t += 1 / 60) {
    const r = step(b, gravityX, 1 / 60);
    b = r.state;
    bumped ||= r.bumped;
  }
  return { b, bumped };
};

test("level phone: the character stays put", () => {
  const { b } = simulate(0.5, 3); // inside the dead zone
  assert.equal(b.x, 0);
});
test("right edge down (gravityX < 0): slides right and leans left (counter-clockwise)", () => {
  const { b } = simulate(-5, 1);
  assert.ok(b.x > 0.2, `x=${b.x}`);
  assert.ok(b.lean > 0.2, `lean=${b.lean}`);
});
test("left edge down: slides left and leans right", () => {
  const { b } = simulate(5, 1);
  assert.ok(b.x < -0.2 && b.lean < -0.2);
});
test("a steep tilt reaches the end of the floor but never goes past it", () => {
  const { b } = simulate(-9, 4);
  assert.ok(b.x > FLOOR_HALF_WIDTH * 0.95 && b.x <= FLOOR_HALF_WIDTH, `x=${b.x}`);
});
test("a very slight tilt (about 8°) does nothing at all", () => {
  const { b } = simulate(-1.4, 4);
  assert.equal(b.x, 0);
});
test("a gentle tilt (about 15°) starts a slow slide downhill", () => {
  const { b } = simulate(-2.5, 1);
  assert.ok(b.x > 0.02 && b.x < 0.3, `x=${b.x}`);
});
test("it slows down before the end of the floor instead of slamming into it", () => {
  let b = { x: 0.8, vx: 1.2, lean: 0 };
  for (let t = 0; t < 1; t += 1 / 60) b = step(b, 0, 1 / 60).state;
  assert.ok(b.x <= FLOOR_HALF_WIDTH);
});
test("a huge frame gap does not teleport the character", () => {
  const r = step(restingBody(), -9, 5);
  assert.ok(Math.abs(r.state.x) < 0.1);
});
