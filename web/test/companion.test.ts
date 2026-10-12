import { test } from "node:test";
import assert from "node:assert/strict";
import { BUBBLE_FRAME_MS, frameGap, IDLE_FRAME_MS, idleCap, SLEEP_FRAME_MS, type IdleState } from "../src/companion";
import { DEVICE } from "../src/device";

test("the default device profile keeps the Realme 3 Pro values", () => {
  assert.deepEqual(DEVICE, { maxPixelRatio: 1.5, idleFps: 30, sleepFrameMs: 50, mapPrewarmMs: 10_000 });
  assert.equal(BUBBLE_FRAME_MS, 1000 / 30 - 4);
  assert.equal(SLEEP_FRAME_MS, 50);
});

test("full screen draws every frame; the bubble ~30 fps; asleep ~20 fps (the slower wins)", () => {
  assert.equal(frameGap(false, false), 0);
  assert.equal(frameGap(true, false), BUBBLE_FRAME_MS);
  assert.equal(frameGap(false, true), SLEEP_FRAME_MS);
  assert.equal(frameGap(true, true), SLEEP_FRAME_MS);
  // At 60 Hz (16.7 ms apart), the bubble skips every other frame but never two in a row.
  assert.ok(BUBBLE_FRAME_MS > 16.7 && BUBBLE_FRAME_MS < 33.4);
});

test("idle: 30 fps only while nothing moves; a tilt or a touch ends it at once; the voice HUD caps too", () => {
  const still: IdleState = { calm: true, turning: false, vx: 0.01, along: 0.2, particles: 0, touchAgoMs: 5000, gravityDelta: 0.05, voiceBusy: false };
  assert.equal(idleCap(still), true);
  assert.equal(frameGap(false, false, true), IDLE_FRAME_MS);
  assert.equal(frameGap(false, true, true), SLEEP_FRAME_MS);
  assert.equal(idleCap({ ...still, calm: false }), false);
  assert.equal(idleCap({ ...still, turning: true }), false);
  assert.equal(idleCap({ ...still, vx: -0.2 }), false);
  assert.equal(idleCap({ ...still, along: 0.8 }), false);
  assert.equal(idleCap({ ...still, particles: 2 }), false);
  assert.equal(idleCap({ ...still, touchAgoMs: 500 }), false);
  assert.equal(idleCap({ ...still, gravityDelta: 0.5 }), false);
  // Listening or thinking: capped even with a finger down (press-to-talk) or while walking, but not on a jolt.
  const voice = { ...still, voiceBusy: true, touchAgoMs: 0, vx: 0.5, calm: false };
  assert.equal(idleCap(voice), true);
  assert.equal(idleCap({ ...voice, gravityDelta: 1 }), false);
  assert.equal(idleCap({ ...voice, turning: true }), false);
});
