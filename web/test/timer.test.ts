import { test } from "node:test";
import assert from "node:assert/strict";
import { TIMER, cleanLabel, clockText, doneLine, drainOffset, edgePath, fraction, onLoad, parseSaved, shownSeconds, spoken, stage } from "../src/timer";

test("the readout is mm:ss, or h:mm:ss from an hour", () => {
  assert.equal(clockText(272), "04:32");
  assert.equal(clockText(0), "00:00");
  assert.equal(clockText(59), "00:59");
  assert.equal(clockText(3600 + 4 * 60 + 32), "1:04:32");
  assert.equal(clockText(-5), "00:00");
});

test("shown seconds round up, so 00:00 appears only at zero", () => {
  assert.equal(shownSeconds(272_001), 273);
  assert.equal(shownSeconds(1), 1);
  assert.equal(shownSeconds(0), 0);
  assert.equal(shownSeconds(-300), 0);
});

test("durations are said the way people say them", () => {
  assert.equal(spoken(1), "1 second");
  assert.equal(spoken(30), "30 seconds");
  assert.equal(spoken(60), "1 minute");
  assert.equal(spoken(90), "a minute and a half");
  assert.equal(spoken(150), "2 and a half minutes");
  assert.equal(spoken(272), "4 minutes 32 seconds");
  assert.equal(spoken(300), "5 minutes");
  assert.equal(spoken(3600), "1 hour");
  assert.equal(spoken(5400), "1 hour 30 minutes");
});

test("the line drains from full to empty", () => {
  assert.equal(fraction(300_000, 300_000), 1);
  assert.equal(fraction(150_000, 300_000), 0.5);
  assert.equal(fraction(0, 300_000), 0);
  assert.equal(fraction(-10, 300_000), 0);
  assert.equal(fraction(400_000, 300_000), 1);
  assert.equal(fraction(10, 0), 0);
  assert.equal(drainOffset(1, 1000), -0);
  assert.equal(drainOffset(0.25, 1000), -750);
  assert.equal(drainOffset(0, 1000), -1000);
});

test("colour stages: green, amber for the last 20 %, pink for the last 10 s", () => {
  assert.equal(stage(300_000, 300_000), "green");
  assert.equal(stage(61_000, 300_000), "green");
  assert.equal(stage(60_000, 300_000), "amber");
  assert.equal(stage(10_001, 300_000), "amber");
  assert.equal(stage(10_000, 300_000), "pink");
  assert.equal(stage(1, 300_000), "pink");
  assert.equal(stage(0, 300_000), "done");
  // A 20 s timer: amber from 4 s is inside the pink 10 s, so it goes green → pink.
  assert.equal(stage(15_000, 20_000), "green");
  assert.equal(stage(9_000, 20_000), "pink");
});

test("the edge path starts at the top centre and its length matches a rounded rectangle", () => {
  const { d, length } = edgePath(360, 780);
  const o = TIMER.inset + TIMER.width / 2;
  assert.ok(d.startsWith(`M180 ${o}H`));
  const r = TIMER.radius;
  const w = 360 - 2 * o, h = 780 - 2 * o;
  assert.ok(Math.abs(length - (2 * (w + h) - 8 * r + 2 * Math.PI * r)) < 1e-9);
});

test("labels are cleaned and capitalised; done lines use them", () => {
  assert.equal(cleanLabel("pasta"), "Pasta");
  assert.equal(cleanLabel("  the <b>eggs</b> "), "The b eggs b");
  assert.equal(cleanLabel(""), undefined);
  assert.equal(cleanLabel(42), undefined);
  assert.equal(doneLine(), "Time's up!");
  assert.equal(doneLine("Pasta"), "Pasta's done!");
  assert.equal(doneLine("Eggs"), "Eggs are done!");
  assert.equal(doneLine("Glass"), "Glass's done!");
  assert.match(doneLine(undefined, true), /Focus time's over/);
});

test("a saved timer resumes, rings at once, or is dropped when long stale", () => {
  const saved = parseSaved(JSON.stringify({ end: 10_000, total: 60_000, label: "pasta" }));
  assert.deepEqual(saved, { end: 10_000, total: 60_000, label: "Pasta" });
  assert.equal(onLoad(saved, 5_000), "run");
  assert.equal(onLoad(saved, 10_000), "fire");
  assert.equal(onLoad(saved, 10_000 + TIMER.staleMs), "fire");
  assert.equal(onLoad(saved, 10_001 + TIMER.staleMs), "drop");
  assert.equal(onLoad(parseSaved(JSON.stringify({ end: 1, total: 60_000, pausedLeft: 30_000 })), 999_999), "paused");
  assert.equal(onLoad(null, 0), "none");
  assert.equal(parseSaved("{nope"), null);
  assert.equal(parseSaved(JSON.stringify({ end: 1, total: -5 })), null);
  assert.equal(parseSaved(JSON.stringify({ end: "x", total: 5 })), null);
  assert.equal(parseSaved(null), null);
});
