import { test } from "node:test";
import assert from "node:assert/strict";
import { FloorPicker } from "../src/floors";
import { REVEAL, restPose, revealDueMs, revealPose, rightingAngle, stowLeft } from "../src/props/timeline";

const upsideDown: [number, number, number] = [0, -9.81, 0];
const sideways: [number, number, number] = [9.81, 0, 0];

test("locking the floor picker returns the old floor, goes back to the bottom and ignores tilt", () => {
  const p = new FloorPicker();
  assert.equal(p.update(upsideDown, 0), null);
  assert.equal(p.update(upsideDown, 400), "top");
  assert.equal(p.lock(), "top");
  assert.equal(p.floor, "bottom");
  assert.ok(p.locked);
  for (let t = 500; t < 8000; t += 100) {
    assert.equal(p.update(upsideDown, t), null);
    assert.equal(p.update(sideways, t + 50), null);
    assert.equal(p.progress(t), 0);
  }
  p.unlock();
  assert.ok(!p.locked);
  assert.equal(p.update(upsideDown, 9000), null); // a fresh hold starts only after unlock
  assert.equal(p.update(upsideDown, 9400), "top");
});

test("unlocking does not carry a hold that began while locked", () => {
  const p = new FloorPicker();
  p.lock();
  p.update(upsideDown, 0);
  p.unlock();
  assert.equal(p.update(upsideDown, 300), null);
});

test("the reveal reaches behind, pops the prop in, turns it to face you, then acts and is ready", () => {
  const pose = restPose();
  revealPose("camera", 0, pose);
  assert.equal(pose.propScale, 0);
  assert.equal(pose.reach, 0);
  revealPose("camera", REVEAL.reachEnd - 1, pose);
  assert.ok(pose.reach > 0.95 && pose.yaw < -0.7 && pose.propScale === 0);
  revealPose("camera", REVEAL.turnEnd, pose);
  assert.ok(pose.hold > 0.99 && Math.abs(pose.yaw) < 0.01 && pose.propTurn > 0.99 && !pose.ready);
  revealPose("camera", REVEAL.actionEnd.camera, pose);
  assert.ok(pose.ready && pose.action === 1);
  revealPose("scroll", REVEAL.actionEnd.camera, pose);
  assert.ok(!pose.ready && pose.action > 0 && pose.action < 1);
  assert.ok(REVEAL.actionEnd.scroll < REVEAL.maxMs && REVEAL.actionEnd.camera < REVEAL.maxMs);
});

test("the wall-clock finish lands on the pose's ready edge, well inside the safety cap", () => {
  const pose = restPose();
  for (const kind of ["camera", "scroll"] as const) {
    const due = revealDueMs(kind);
    assert.ok(!revealPose(kind, due - 1, pose).ready, `${kind}: not ready a frame early`);
    assert.ok(revealPose(kind, due, pose).ready, `${kind}: ready when due`);
    // The cap is only a net: it must not fire before a normal finish, nor make a stalled open wait long.
    assert.ok(REVEAL.maxMs - due >= 200, `${kind}: cap leaves room for a late frame`);
  }
  assert.ok(REVEAL.maxMs <= 1300);
});

test("every reveal is done within a second", () => {
  assert.ok(REVEAL.actionEnd.camera <= 1000 && REVEAL.actionEnd.scroll <= 1000);
});

test("the room turns back upright the short way round", () => {
  assert.ok(Math.abs(rightingAngle(-Math.PI / 2, 0, 1)) < 1e-9);
  assert.ok(Math.abs(rightingAngle(Math.PI * 1.5, 0, 1) - Math.PI * 2) < 1e-9); // 3π/2 → 2π, not back through π
  assert.equal(rightingAngle(Math.PI, 0, 0), Math.PI);
});

test("the stow runs on the wall clock: a frame after a long pause finds the prop already gone", () => {
  assert.equal(stowLeft(0), 1);
  assert.ok(Math.abs(stowLeft(REVEAL.stowMs / 2) - 0.5) < 1e-9);
  assert.equal(stowLeft(REVEAL.stowMs), 0);
  assert.equal(stowLeft(5000), 0); // the page was paused (permission dialog, hidden tab) through the whole stow
});
