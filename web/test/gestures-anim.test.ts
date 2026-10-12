import { test } from "node:test";
import assert from "node:assert/strict";
import { respond, type Command, type Notes } from "../src/assistant";
import { carryOver, EASE_IN, EASE_OUT, GESTURES, gesturePose, keys, reactionFor, restGesturePose, type GestureName } from "../src/gestures-anim";

const noNotes: Notes = { all: () => [], add: () => undefined };
const cmd = (name: string, args: Record<string, unknown> = {}, text = "hi"): Command => ({ name, args, confidence: 1, text });
const reaction = (name: string, args: Record<string, unknown> = {}, notes = noNotes) => {
  const c = cmd(name, args);
  return reactionFor(c, respond(c, notes));
};

test("every reaction is short (≤ 1.5 s) except the held thinking pose", () => {
  for (const [name, spec] of Object.entries(GESTURES)) {
    if (spec.hold) continue;
    assert.ok(spec.ms <= 1500, `${name} lasts ${spec.ms} ms`);
    for (const [at] of spec.clips ?? []) assert.ok(at < spec.ms, `${name} clip at ${at}`);
    for (const fx of spec.fx ?? []) assert.ok(fx.at < spec.ms, `${name} fx at ${fx.at}`);
  }
});

test("a reaction eases in from rest, back to rest at its end, and then reports it is over", () => {
  const p = restGesturePose();
  for (const name of Object.keys(GESTURES) as GestureName[]) {
    const spec = GESTURES[name];
    assert.equal(gesturePose(name, 0, null, p), true);
    assert.equal(p.pitch + p.yaw + p.roll + p.stretch + p.lift + p.lean + p.arm, 0, `${name} starts at rest`);
    if (spec.hold) {
      assert.equal(gesturePose(name, 10_000, null, p), true, `${name} is held`);
      assert.equal(gesturePose(name, 10_000, EASE_OUT, p), false, `${name} lets go when released`);
      continue;
    }
    assert.equal(gesturePose(name, spec.ms - 1, null, p), true);
    for (const v of [p.pitch, p.yaw, p.roll, p.stretch, p.lift, p.lean, p.arm]) assert.ok(Math.abs(v) < 0.01, `${name} ends near rest`);
    assert.equal(gesturePose(name, spec.ms, null, p), false, `${name} is over`);
    assert.equal(p.arm, 0);
  }
});

test("looking at the sky tilts the head up and scans from one side to the other", () => {
  const p = restGesturePose();
  gesturePose("lookUp", 300, null, p);
  const early = p.yaw;
  assert.ok(p.pitch < -0.3, "head up");
  gesturePose("lookUp", 1100, null, p);
  assert.ok(p.pitch < -0.3);
  assert.ok(early < -0.2 && p.yaw > 0.2, `scans ${early} → ${p.yaw}`);
});

test("the wrist glance raises the right arm and drops the head", () => {
  const p = restGesturePose();
  gesturePose("wrist", 700, null, p);
  assert.equal(p.armR, "wrist");
  assert.ok(p.arm > 0.9);
  assert.ok(p.pitch > 0.3);
});

test("a cut-off reaction fades out under the new one instead of jumping", () => {
  const from = restGesturePose();
  gesturePose("lookUp", 700, null, from);
  const out = restGesturePose();
  gesturePose("nod", 0, null, out);
  assert.equal(carryOver(0, from, out), 1);
  assert.equal(out.pitch, from.pitch);
  gesturePose("nod", EASE_IN, null, out);
  assert.equal(carryOver(EASE_IN, from, out), 0);
  assert.equal(out.pitch, 0);
});

test("keyframes are smooth and held at both ends", () => {
  const k = [[100, 0], [200, 1]] as const;
  assert.equal(keys(0, k), 0);
  assert.equal(keys(150, k), 0.5);
  assert.equal(keys(500, k), 1);
});

test("each command gets its reaction", () => {
  assert.equal(reaction("look_up"), "lookUp");
  assert.equal(reaction("sky", { seen: 8, used: 5 }), "lookUp");
  assert.equal(reaction("dark", { sunElevation: -10 }), "lookUp");
  assert.equal(reaction("place", { fix: true, near: "Zwinger", category: "sight" }), "lookAround");
  assert.equal(reaction("place", { looking: true }), "lookUp");
  assert.equal(reaction("clock", { hhmm: "10:00", weekday: "Monday", hour: 10, ask: "time" }), "wrist");
  assert.equal(reaction("clock", { hhmm: "10:00", weekday: "Monday", hour: 10, ask: "day" }), "nod");
  assert.equal(reaction("battery", { level: 64, charging: false }), "patChest");
  assert.equal(reaction("battery", { level: 12, charging: false }), "lowBattery");
  assert.equal(reaction("battery", { level: 40, charging: true }), "charging");
  assert.equal(reaction("battery", {}), null);
  assert.equal(reaction("altitude", { m: 120 }), "tiptoe");
  assert.equal(reaction("speed", { fix: true, moving: true, kmh: 4 }), "steps");
  assert.equal(reaction("set_timer", { minutes: 1 }), "pointEdge");
  assert.equal(reaction("set_timer", { minutes: -1 }), null);
  assert.equal(reaction("remember_note", { text: "my locker is 42" }), "tapHead");
  const notes: Notes = { all: () => ["my locker is 42"], add: () => undefined };
  const found = cmd("recall_note", { topic: "locker" }, "where is my locker");
  assert.equal(reactionFor(found, respond(found, notes)), "recall");
  assert.equal(reaction("recall_note", { topic: "bike" }), "recallMiss");
  assert.equal(reaction("smalltalk", { kind: "greet" }), "wave");
  assert.equal(reaction("smalltalk", { kind: "bye" }), "wave");
  assert.equal(reaction("smalltalk", { kind: "love" }), "love");
  assert.equal(reaction("smalltalk", { kind: "thanks" }), "hop");
  assert.equal(reaction("smalltalk", { kind: "how_are_you" }), "thumbs");
  assert.equal(reaction("help"), "help");
  assert.equal(reaction("mute"), "hush");
  assert.equal(reaction("unmute"), "ahem");
  assert.equal(reaction("sun"), "squint");
  assert.equal(reaction("metal"), "sniff");
  assert.equal(reaction("dance"), null); // the dance is its own thing
  assert.equal(reaction("take_photo"), null); // features open with their prop reveal instead
});

test("\"look at the sky\" gets a spoken line", () => {
  const out = respond(cmd("look_up", {}, "look at the sky"), noNotes);
  assert.equal(out.action.kind, "nod");
  assert.match(out.reply, /sky/);
});

test("fun commands get their reactions", () => {
  assert.equal(reaction("fun", { kind: "joke" }), "giggle");
  assert.equal(reaction("fun", { kind: "fact" }), "proud");
  assert.equal(reaction("fun", { kind: "coin" }), "coin");
  assert.equal(reaction("fun", { kind: "dice", count: 1 }), "dice");
  assert.ok(["rpsRock", "rpsPaper", "rpsScissors"].includes(String(reaction("fun", { kind: "rps" }))));
  assert.equal(reaction("fun", { kind: "song" }), null); // the song dances
});
