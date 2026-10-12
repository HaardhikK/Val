import { test } from "node:test";
import assert from "node:assert/strict";
import { GestureDetector, type Gesture } from "../src/gestures";
import { TRACES } from "../src/traces";

const run = (name: string): Gesture[] => {
  const d = new GestureDetector();
  return TRACES[name]().flatMap((s) => d.push(s));
};

test("holding still fires nothing", () => assert.deepEqual(run("still"), []));
test("tilting fires no gesture (tilt is physics, not a gesture)", () => {
  assert.deepEqual(run("tiltRight"), []);
  assert.deepEqual(run("tiltLeft"), []);
});
test("shake fires once", () => assert.deepEqual(run("shake"), ["shake"]));
test("wiggle fires wiggle, not shake", () => assert.deepEqual(run("wiggle"), ["wiggle"]));
test("face down then up fires sleep and wake", () => assert.deepEqual(run("faceDown"), ["faceDown", "faceUp"]));
test("lifting a resting phone fires pickup", () => assert.deepEqual(run("pickup"), ["pickup"]));
test("walking (hard jolts, little turning) fires no shake", () => assert.deepEqual(run("walk"), []));
test("a knock on the table while the phone lies flat fires no pickup", () => assert.deepEqual(run("knock"), []));
test("a knock, then a real lift, fires pickup once", () => {
  const d = new GestureDetector();
  const lift = TRACES.pickup().map((s) => ({ ...s, t: s.t + 4520 }));
  assert.deepEqual([...TRACES.knock(), ...lift].flatMap((s) => d.push(s)), ["pickup"]);
});
test("spinning flat fires spin", () => assert.deepEqual(run("spin"), ["spin"]));
test("a tilted phone held still then shaken does not fire pickup", () => {
  const d = new GestureDetector();
  const out = [...TRACES.tiltRight(), ...TRACES.shake().map((x) => ({ ...x, t: x.t + 4100 }))].flatMap((s) => d.push(s));
  assert.deepEqual(out, ["shake"]);
});
test("a gently lifted phone forgets it was resting, so a later shake fires no stale pickup", () => {
  const d = new GestureDetector();
  const flat = TRACES.pickup().slice(0, 180).map((s) => ({ ...s, linear: [0, 0, 0] as [number, number, number] })); // 3.6 s flat, no jolt
  const held = TRACES.still().map((s) => ({ ...s, t: s.t + 3700 }));
  const shaken = TRACES.shake().map((s) => ({ ...s, t: s.t + 6000 }));
  assert.deepEqual([...flat, ...held, ...shaken].flatMap((s) => d.push(s)), ["shake"]);
});
