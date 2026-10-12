import { test } from "node:test";
import assert from "node:assert/strict";
import { charsPerTick, MIN_SPOKEN_CHAR_MS, smoothLevel, spokenChars, truncate, voiceSetting } from "../src/hud";

test("short transcripts pass through, whitespace collapsed", () => {
  assert.equal(truncate("  set a   timer \n for one minute "), "set a timer for one minute");
});

test("long transcripts cut at a word break with an ellipsis", () => {
  const long = "remember that my locker is number forty two on the second floor near the stairs by the big window please";
  const out = truncate(long, 40);
  assert.ok(out.length <= 40, out);
  assert.ok(out.endsWith("…"));
  assert.ok(long.startsWith(out.slice(0, -1)));
});

test("one long word is hard-cut", () => {
  assert.equal(truncate("a".repeat(50), 10), `${"a".repeat(9)}…`);
});

test("long replies end at their last whole sentence, or else the last word", () => {
  const reply = "The Zwinger is a baroque palace. It was built from 1710 to 1728 for Augustus the Strong. It holds the Old Masters gallery.";
  assert.equal(truncate(reply, 100, true), "The Zwinger is a baroque palace. It was built from 1710 to 1728 for Augustus the Strong.");
  assert.equal(truncate("Version 3.5 of the map shows the river and the old town with many more bridges", 30, true), "Version 3.5 of the map shows…");
  assert.equal(truncate("Hi. " + "word ".repeat(30), 60, true).endsWith("…"), true, "a sentence end in the first half does not win");
  assert.equal(truncate("Short and sweet.", 300, true), "Short and sweet.");
});

test("level rises fast and falls slowly", () => {
  assert.ok(smoothLevel(0, 1) >= 0.7);
  const down = smoothLevel(1, 0);
  assert.ok(down > 0.6 && down < 1);
});

test("level clamps bad input", () => {
  assert.equal(smoothLevel(0, Number.NaN), 0);
  assert.ok(smoothLevel(0, 5) <= 1);
  assert.equal(smoothLevel(0, -3), 0);
});

test("typing: one char per tick for short replies, long ones finish within 1.5 s", () => {
  assert.equal(charsPerTick(0), 1);
  assert.equal(charsPerTick(60), 1);
  const len = 400;
  const ticks = Math.ceil(len / charsPerTick(len));
  assert.ok(ticks * 25 <= 1500, `${ticks} ticks`);
});

test("spoken typing ends when the chunk's audio ends", () => {
  assert.equal(spokenChars(0, 20, 2000), 0);
  assert.equal(spokenChars(1000, 20, 2000), 10);
  assert.equal(spokenChars(2000, 20, 2000), 20);
  assert.equal(spokenChars(9999, 20, 2000), 20);
});

test("spoken typing never goes faster than the floor", () => {
  assert.equal(spokenChars(150, 100, 100), Math.floor(150 / MIN_SPOKEN_CHAR_MS));
  assert.equal(spokenChars(150, 100, Number.NaN), 10);
  assert.equal(spokenChars(-5, 10, 1000), 0);
  assert.equal(spokenChars(100, 0, 1000), 0);
});

test("voice setting defaults on, persists off, survives broken storage", () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  const v = voiceSetting(store);
  assert.equal(v.on, true);
  v.set(false);
  assert.equal(voiceSetting(store).on, false);
  v.set(true);
  assert.equal(voiceSetting(store).on, true);
  const fail = () => {
    throw new Error("blocked");
  };
  const b = voiceSetting({ getItem: fail, setItem: fail });
  assert.equal(b.on, true);
  b.set(false);
  assert.equal(b.on, false);
  assert.equal(voiceSetting(null).on, true);
});
