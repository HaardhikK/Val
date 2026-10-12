import { test } from "node:test";
import assert from "node:assert/strict";
import { DRESDEN, duration, moonName, moonPhase, nextSunEvent, spokenDuration, sunLine, sunSpeech, sunTimes } from "../src/delight/sun";

const MIN = 60_000;
const near = (got: Date | null, want: string, tolMin = 3) => {
  assert.ok(got, `expected a time near ${want}`);
  const diff = Math.abs(got.getTime() - Date.parse(want)) / MIN;
  assert.ok(diff <= tolMin, `${got.toISOString()} is ${diff.toFixed(1)} min from ${want}`);
};

// Hand check: declination about -6.9°, hour angle 82.8° → day length 11 h 02 min around a 12:52 noon.
// (The rough "07:15 / 18:30" first assumed for this date is 5–7 min off.)
test("Dresden 2026-10-10: sunrise 07:20 CEST, sunset 18:23 CEST", () => {
  const t = sunTimes(new Date("2026-10-10T12:00:00+02:00"), DRESDEN.lat, DRESDEN.lon);
  near(t.sunrise, "2026-10-10T07:20:00+02:00");
  near(t.sunset, "2026-10-10T18:23:00+02:00");
  near(t.noon, "2026-10-10T12:52:00+02:00");
  // Civil twilight is roughly half an hour either side at this latitude in October.
  assert.ok(t.dawn && t.sunrise && t.sunrise.getTime() - t.dawn.getTime() > 25 * MIN && t.sunrise.getTime() - t.dawn.getTime() < 45 * MIN);
  assert.ok(t.dusk && t.sunset && t.dusk.getTime() - t.sunset.getTime() > 25 * MIN && t.dusk.getTime() - t.sunset.getTime() < 45 * MIN);
});

test("London summer solstice 2024: 04:43 / 21:21 BST", () => {
  const t = sunTimes(new Date("2024-06-20T12:00:00Z"), 51.5074, -0.1278);
  near(t.sunrise, "2024-06-20T04:43:00+01:00");
  near(t.sunset, "2024-06-20T21:21:00+01:00");
});

test("New York winter solstice 2024 (west longitude): 07:17 / 16:32 EST", () => {
  const t = sunTimes(new Date("2024-12-21T12:00:00-05:00"), 40.7128, -74.006);
  near(t.sunrise, "2024-12-21T07:17:00-05:00");
  near(t.sunset, "2024-12-21T16:32:00-05:00");
});

test("polar night has no sunrise", () => {
  const t = sunTimes(new Date("2024-12-21T12:00:00Z"), 78.22, 15.65); // Longyearbyen
  assert.equal(t.sunrise, null);
  assert.equal(t.sunset, null);
  assert.equal(nextSunEvent(new Date("2024-12-21T12:00:00Z"), 78.22, 15.65), null);
});

test("moon is full at the 2026-03-03 total lunar eclipse", () => {
  const m = moonPhase(new Date("2026-03-03T11:33:00Z"));
  assert.ok(m.illumination > 0.99, `illumination ${m.illumination}`);
  assert.ok(Math.abs(m.phase - 0.5) < 0.02, `phase ${m.phase}`);
});

test("moon is new at the 2024-04-08 total solar eclipse", () => {
  const m = moonPhase(new Date("2024-04-08T18:17:00Z"));
  assert.ok(m.illumination < 0.01, `illumination ${m.illumination}`);
});

test("moon waxes after new and wanes after full", () => {
  assert.equal(moonPhase(new Date("2024-04-12T12:00:00Z")).waxing, true);
  assert.equal(moonPhase(new Date("2026-03-07T12:00:00Z")).waxing, false);
});

test("next event: before sunrise, during the day, after sunset", () => {
  assert.equal(nextSunEvent(new Date("2026-10-10T05:00:00+02:00"))?.kind, "rise");
  assert.equal(nextSunEvent(new Date("2026-10-10T12:00:00+02:00"))?.kind, "set");
  const evening = nextSunEvent(new Date("2026-10-10T22:00:00+02:00"));
  assert.equal(evening?.kind, "rise");
  near(evening!.at, "2026-10-11T07:21:00+02:00");
});

test("sun line reads naturally", () => {
  const line = sunLine(new Date("2026-10-10T17:40:00+02:00"));
  assert.match(line, /^Sunset in 4\d min · (new moon|crescent|half moon|gibbous moon|full moon)$/);
  assert.match(sunLine(new Date("2026-10-10T22:00:00+02:00")), /^Sunrise in 9 h( \d+ min)? · /);
  assert.equal(duration(42 * MIN), "42 min");
  assert.equal(duration(185 * MIN), "3 h 5 min");
  assert.equal(duration(120 * MIN), "2 h");
  assert.equal(duration(10_000), "1 min");
});

test("spoken durations use whole words", () => {
  assert.equal(spokenDuration(MIN), "1 minute");
  assert.equal(spokenDuration(42 * MIN), "42 minutes");
  assert.equal(spokenDuration(60 * MIN), "1 hour");
  assert.equal(spokenDuration(121 * MIN), "2 hours and 1 minute");
  assert.equal(moonName(0), "new");
  assert.equal(moonName(0.5), "full");
  assert.equal(moonName(0.99), "new");
  assert.match(sunSpeech(new Date("2026-10-10T22:00:00+02:00"), "when does the sun set"), /^The sun set at \d\d:\d\d\. It's back in 9 hours and \d+ minutes?, at \d\d:\d\d!$/);
  assert.match(sunSpeech(new Date("2026-10-10T22:00:00+02:00"), "when is sunrise"), /^Sunrise is in 9 hours/);
  assert.match(sunSpeech(new Date("2026-10-10T12:00:00+02:00"), "when is sunset"),/^Sunset is in 6 hours and \d+ minutes, at \d\d:\d\d\. Plenty of light left!$/);
});
