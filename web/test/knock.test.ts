import { test } from "node:test";
import assert from "node:assert/strict";
import { SEISMO_FADE_MS, SEISMO_HOLD_MS, SEISMO_HZ, SEISMO_POINTS, SeismoTrace, glanceDir, knockReaction, parseKnock } from "../src/knock";

test("parseKnock accepts the app's two messages", () => {
  assert.deepEqual(parseKnock({ type: "knock", n: 1, side: "left", peak: 3.2 }), { type: "knock", n: 1, side: "left", peak: 3.2 });
  assert.deepEqual(parseKnock({ type: "knocks", n: 3 }), { type: "knocks", n: 3, side: null });
});

test("parseKnock drops malformed messages and unknown sides", () => {
  assert.equal(parseKnock({ type: "knock", n: 0 }), null);
  assert.equal(parseKnock({ type: "knock", n: 1.5 }), null);
  assert.equal(parseKnock({ type: "knock", n: "2" as unknown as number, side: "left" })?.n, 2); // numeric strings are fine
  assert.equal(parseKnock({ type: "knocks", n: 99 }), null);
  assert.equal(parseKnock({ type: "motion", n: 1 }), null);
  assert.equal(parseKnock({ type: "knocks", n: 2, side: "<b>" })?.side, null);
  assert.equal((parseKnock({ type: "knock", n: 1, peak: 1e9 }) as { peak: number }).peak, 50);
});

test("one knock hops, two ask who's there, three dance", () => {
  assert.equal(knockReaction(1, "normal"), "hop");
  assert.equal(knockReaction(2, "normal"), "whosThere");
  assert.equal(knockReaction(3, "normal"), "dance");
  assert.equal(knockReaction(5, "normal"), "dance");
});

test("asleep: two knocks wake him, one does not", () => {
  assert.equal(knockReaction(1, "sleeping"), "none");
  assert.equal(knockReaction(2, "sleeping"), "wake");
  assert.equal(knockReaction(3, "sleeping"), "wake");
});

test("busy modes ignore knocks", () => {
  for (const mode of ["falling", "carried", "tumbling", "dancing"] as const) assert.equal(knockReaction(2, mode), "none");
});

test("glance directions follow the screen", () => {
  assert.deepEqual(glanceDir("left"), [-1, 0]);
  assert.deepEqual(glanceDir("top"), [0, 1]);
  assert.equal(glanceDir(null), null);
});

test("the seismograph is hidden until a knock, then fades out after the hold", () => {
  const s = new SeismoTrace();
  assert.equal(s.advance(1000), false);
  s.kick(1000, 1);
  assert.equal(s.advance(1500), true);
  assert.equal(s.opacity(1000 + SEISMO_HOLD_MS), 1);
  assert.ok(s.opacity(1000 + SEISMO_HOLD_MS + SEISMO_FADE_MS / 2) < 1);
  assert.equal(s.advance(1000 + SEISMO_HOLD_MS + SEISMO_FADE_MS + 1), false);
});

test("a knock rings in amber and dies back to a cream line", () => {
  const s = new SeismoTrace();
  s.kick(0, 1);
  s.advance(250); // ~12 samples after the knock
  const spikes = Array.from(s.spike).reduce((a, b) => a + b, 0);
  assert.ok(spikes >= 8, `amber samples right after a knock (${spikes})`);
  const peak = Math.max(...Array.from(s.value, Math.abs));
  assert.ok(peak > 0.5, `the knock shows as a spike (${peak})`);
  s.advance(350 + (SEISMO_POINTS * 1000) / SEISMO_HZ); // more than a whole strip later
  assert.equal(Array.from(s.spike).reduce((a, b) => a + b, 0), 0);
  assert.ok(Math.max(...Array.from(s.value, Math.abs)) < 0.15, "back to the idle wobble");
});

test("a new knock after a quiet spell starts a clean strip", () => {
  const s = new SeismoTrace();
  s.kick(0, 1);
  s.advance(200);
  s.advance(SEISMO_HOLD_MS + SEISMO_FADE_MS + 10); // hidden
  s.kick(10_000, 0.2);
  assert.equal(Array.from(s.spike).reduce((a, b) => a + b, 0), 0);
  assert.equal(Math.max(...Array.from(s.value, Math.abs)), 0);
});
