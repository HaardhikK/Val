import { test } from "node:test";
import assert from "node:assert/strict";
import { REACTION, createReactions } from "../src/delight/reactions";
import { parseSensor } from "../src/bridge";

function rig(free = true) {
  const calls: string[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  let now = 0;
  const character = {
    mood: (m: string, a: number) => calls.push(`mood ${m} ${a}`),
    emote: (n: string) => calls.push(`emote ${n}`),
    hop: () => calls.push("hop"),
    tuckHead: (a: number) => calls.push(`tuck ${a}`),
    setPace: (k: number) => calls.push(`pace ${k}`),
    free: () => free,
  };
  const effects = {
    pop: (e: string) => calls.push(`pop ${e}`),
    haptic: (p: string) => calls.push(`haptic ${p}`),
    sunglasses: (on: boolean) => calls.push(`sunglasses ${on}`),
    lantern: (on: boolean) => calls.push(`lantern ${on}`),
  };
  const r = createReactions(character, effects, (fn, ms) => timers.push({ at: now + ms, fn }), () => now);
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  return { r, calls, advance, at: () => now, setFree: (f: boolean) => (free = f) };
}

test("peekaboo: near hides, far says boo with a hop and a giggle", () => {
  const { r, calls, advance, at } = rig();
  r.handle({ type: "proximity", near: true }, at());
  assert.deepEqual(calls, ["mood Surprised 0.6", "tuck 1"]);
  advance(800);
  r.handle({ type: "proximity", near: false }, at());
  assert.ok(calls.includes("hop") && calls.includes("haptic giggle") && calls.includes("tuck 0"));
  advance(REACTION.booRelax);
  assert.equal(calls.at(-1), "pace 1");
  assert.ok(calls.includes("mood Surprised 0"));
});

test("a flicker shorter than minHide gives no boo", () => {
  const { r, calls, advance, at } = rig();
  r.handle({ type: "proximity", near: true }, at());
  advance(100);
  r.handle({ type: "proximity", near: false }, at());
  assert.ok(!calls.includes("hop"));
  assert.ok(calls.includes("tuck 0"));
});

test("a long cover (pocket) gives no boo", () => {
  const { r, calls, advance, at } = rig();
  r.handle({ type: "proximity", near: true }, at());
  advance(REACTION.maxHide + 1);
  r.handle({ type: "proximity", near: false }, at());
  assert.ok(!calls.includes("hop"));
});

test("boo cooldown: a quick second cover is ignored", () => {
  const { r, calls, advance, at } = rig();
  r.handle({ type: "proximity", near: true }, at());
  advance(500);
  r.handle({ type: "proximity", near: false }, at());
  calls.length = 0;
  advance(1000);
  r.handle({ type: "proximity", near: true }, at());
  assert.deepEqual(calls, REACTION.booRelax <= 1000 ? ["mood Surprised 0", "pace 1"] : []);
  advance(REACTION.booCooldown);
  calls.length = 0;
  r.handle({ type: "proximity", near: true }, at());
  assert.deepEqual(calls, ["mood Surprised 0.6", "tuck 1"]);
});

test("no peekaboo while asleep or carried", () => {
  const { r, calls, at } = rig(false);
  r.handle({ type: "proximity", near: true }, at());
  r.handle({ type: "proximity", near: false }, at());
  assert.deepEqual(calls, []);
});

test("dark: lantern, moon, sleepy face and slow idle; bright: sunglasses", () => {
  const { r, calls, advance, at } = rig();
  r.handle({ type: "light", level: "dark", lux: 3 }, at());
  assert.deepEqual(calls, ["lantern true", "sunglasses false", "pop ☾", "mood Sad 0.3", "pace 0.6"]);
  calls.length = 0;
  advance(REACTION.lightDwell);
  r.handle({ type: "light", level: "bright", lux: 9000 }, at());
  assert.deepEqual(calls, ["lantern false", "sunglasses true", "emote ThumbsUp", "mood Sad 0", "pace 1"]);
});

test("light changes inside the dwell are coalesced into one later change", () => {
  const { r, calls, advance, at } = rig();
  r.handle({ type: "light", level: "dark", lux: 3 }, at());
  calls.length = 0;
  advance(1000);
  r.handle({ type: "light", level: "normal", lux: 200 }, at());
  r.handle({ type: "light", level: "bright", lux: 9000 }, at());
  r.handle({ type: "light", level: "dark", lux: 3 }, at());
  assert.deepEqual(calls, []);
  advance(REACTION.lightDwell);
  assert.deepEqual(calls, []); // it ended where it started: nothing to show
  r.handle({ type: "light", level: "normal", lux: 200 }, at());
  assert.ok(calls.includes("lantern false"));
});

test("battery: low and unplugged droops; plugging in noms once per cooldown", () => {
  const { r, calls, advance, at } = rig();
  r.handle({ type: "battery", level: 15, charging: false, temp: 30 }, at());
  assert.deepEqual(calls, ["mood Sad 0.4", "pace 0.8"]);
  calls.length = 0;
  r.handle({ type: "battery", level: 15, charging: true, temp: 30 }, at());
  assert.deepEqual(calls, ["mood Sad 0", "pace 1", "pop ϟ", "haptic tick", "emote Yes"]);
  calls.length = 0;
  advance(2000);
  r.handle({ type: "battery", level: 15, charging: false, temp: 30 }, at());
  r.handle({ type: "battery", level: 15, charging: true, temp: 30 }, at());
  assert.ok(!calls.includes("pop ϟ"), "wobbly cable: no second nom");
  assert.equal(r.state.lowBattery, false);
});

test("the first battery reading while charging is not a plug-in", () => {
  const { r, calls, at } = rig();
  r.handle({ type: "battery", level: 80, charging: true, temp: 30 }, at());
  assert.deepEqual(calls, []);
});

test("parseSensor accepts good messages and drops malformed ones", () => {
  assert.deepEqual(parseSensor({ type: "proximity", near: true }), { type: "proximity", near: true });
  assert.deepEqual(parseSensor({ type: "light", level: "dark", lux: 2.5 }), { type: "light", level: "dark", lux: 2.5 });
  assert.equal(parseSensor({ type: "light", level: "dim" }), null);
  assert.equal(parseSensor({ type: "proximity", near: "yes" }), null);
  assert.equal(parseSensor({ type: "battery", level: "15", charging: false }), null);
});
