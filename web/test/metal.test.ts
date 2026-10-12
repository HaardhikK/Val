import { test } from "node:test";
import assert from "node:assert/strict";
import { LINES, METAL, createMetalLogic, level, litSegments, meterLabel, nextHeat, tickGap } from "../src/metal";
import { parseMag } from "../src/bridge";
import { respond, type Notes } from "../src/assistant";

function rig() {
  const calls: string[] = [];
  let now = 0;
  const m = createMetalLogic({
    send: (e) => calls.push(e.type === "haptic" ? `haptic ${e.pattern}` : JSON.stringify(e)),
    speak: (t) => calls.push(`say ${t}`),
    log: (t) => calls.push(`log ${t}`),
    surprise: (a) => calls.push(`surprise ${a}`),
    lookUp: (on) => calls.push(`look ${on}`),
    hop: () => calls.push("hop"),
    meter: {
      show: () => calls.push("meter show"),
      hide: () => calls.push("meter hide"),
      set: (delta, lit, heat) => calls.push(`meter ${delta} ${lit} ${heat}`),
    },
    clock: () => now,
  });
  const feed = (delta: number, ut = 49 + delta) => m.feed({ type: "mag", ut, delta });
  return { m, calls, feed, advance: (ms: number) => (now += ms) };
}

test("the scale: calm noise, a spoon is warm, a magnet fills the bar", () => {
  assert.equal(litSegments(0), 0);
  assert.equal(litSegments(-5), 0);
  assert.ok(litSegments(15) >= 3 && litSegments(15) <= 6);
  assert.equal(litSegments(METAL.full), METAL.segments);
  assert.equal(litSegments(5000), METAL.segments);
  assert.ok(level(30) > level(20));
});

test("hot has hysteresis", () => {
  assert.equal(nextHeat("calm", 5), "calm");
  assert.equal(nextHeat("calm", 20), "warm");
  assert.equal(nextHeat("warm", 59), "warm");
  assert.equal(nextHeat("warm", 60), "hot");
  assert.equal(nextHeat("hot", 50), "hot");
  assert.equal(nextHeat("hot", 40), "warm");
});

test("ticks get faster as it warms", () => {
  assert.equal(tickGap("calm", 5), Infinity);
  assert.ok(tickGap("warm", 15) > tickGap("warm", 50));
  assert.ok(tickGap("warm", 59) > tickGap("hot", 80));
});

test("open turns the magnetometer on and shows the meter; close turns it off", () => {
  const { m, calls } = rig();
  m.open();
  assert.ok(m.on);
  assert.deepEqual(calls, ['{"type":"metal","on":true}', "meter null 0 calm", "meter show", "log metal on"]);
  m.open(); // twice is once
  assert.equal(calls.filter((c) => c.includes('"on":true')).length, 1);
  calls.length = 0;
  m.close(true);
  assert.ok(!m.on);
  assert.ok(calls.includes('{"type":"metal","on":false}') && calls.includes("meter hide") && calls.includes(`say ${LINES.exit}`));
  calls.length = 0;
  m.close(true); // already closed: silent
  assert.deepEqual(calls, []);
});

test("readings are ignored while the mode is off", () => {
  const { calls, feed } = rig();
  feed(100);
  assert.deepEqual(calls, []);
});

test("warm ticks, hot bumps and logs once, eyes widen, Val looks up", () => {
  const { m, calls, feed, advance } = rig();
  m.open();
  calls.length = 0;
  feed(3);
  assert.ok(!calls.some((c) => c.startsWith("haptic")));
  feed(30);
  assert.ok(calls.includes("haptic tick") && calls.includes("look true"));
  const eyes = calls.filter((c) => c.startsWith("surprise")).map((c) => Number(c.split(" ")[1]));
  assert.ok(eyes.at(-1)! > 0.15);
  calls.length = 0;
  feed(30); // within the tick gap: no buzz
  assert.ok(!calls.includes("haptic tick"));
  advance(1000);
  feed(80);
  assert.ok(calls.includes("haptic bump") && calls.includes("log metal hot"));
  advance(1000);
  feed(85);
  assert.equal(calls.filter((c) => c === "log metal hot").length, 1);
  calls.length = 0;
  feed(2);
  assert.ok(calls.includes("look false") && calls.includes("surprise 0"));
});

test("a big spike hops and speaks once per opening", () => {
  const { m, calls, feed, advance } = rig();
  m.open();
  feed(220);
  advance(2000);
  feed(10);
  advance(2000);
  feed(240);
  assert.equal(calls.filter((c) => c === "hop").length, 1);
  assert.equal(calls.filter((c) => c === `say ${LINES.spike}`).length, 1);
  m.close();
  m.open();
  feed(240);
  assert.equal(calls.filter((c) => c === "hop").length, 2);
});

test("no magnetometer: the mode closes with a line", () => {
  const { m, calls } = rig();
  m.open();
  m.feed({ type: "magError", reason: "no sensor" });
  assert.ok(!m.on);
  assert.equal(calls.at(-1), `say ${LINES.noSensor}`);
});

test("mag messages are validated", () => {
  assert.deepEqual(parseMag({ type: "mag", ut: 52.1, delta: 3 }), { type: "mag", ut: 52.1, delta: 3 });
  assert.equal(parseMag({ type: "mag", ut: "x", delta: 3 }), null);
  assert.equal(parseMag({ type: "fix" }), null);
  assert.equal(parseMag({ type: "magError" })?.type, "magError");
});

test("the voice commands open and close the mode", () => {
  const notes: Notes = { all: () => [], add: () => undefined };
  assert.deepEqual(respond({ name: "metal", args: {}, confidence: 1, text: "find metal" }, notes), { action: { kind: "metal", on: true }, reply: LINES.enter });
  assert.deepEqual(respond({ name: "stop", args: {}, confidence: 1, text: "stop" }, notes).action, { kind: "metal", on: false });
});

test("the label shows the deviation the bar shows, not the absolute field", () => {
  assert.equal(meterLabel(null), "METAL ▸ -- µT");
  assert.equal(meterLabel(12.4), "METAL ▸ +12 µT");
  assert.equal(meterLabel(0), "METAL ▸ +0 µT");
  assert.equal(meterLabel(Number.NaN), "METAL ▸ -- µT");
});

test("the meter gets the delta, so the label and the bar agree", () => {
  const { m, calls, feed } = rig();
  m.open();
  calls.length = 0;
  feed(12);
  assert.ok(calls.some((c) => c.startsWith(`meter 12 ${litSegments(12)} `)), calls.join("|"));
});
