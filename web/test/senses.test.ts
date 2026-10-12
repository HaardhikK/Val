import { test } from "node:test";
import assert from "node:assert/strict";
import { respond, type Notes } from "../src/assistant";
import { gpsStatusText } from "../src/map/geo";
import { LOOKING_LINE, ordinal, placePhrase, SENSE_COMMANDS, senseReply } from "../src/senses";

const noNotes: Notes = { all: () => [], add: () => undefined };
const say = (name: string, args: Record<string, unknown>, text = "") => senseReply(name, args, text).reply;

test("clock: time, day, date, weekend; never a made-up time", () => {
  const clock = { hhmm: "22:10", weekday: "Saturday", day: 10, month: "October", year: 2026, hour: 22 };
  assert.equal(say("clock", { ...clock, ask: "time" }), "It's 22:10. Getting late, sleepyhead!");
  assert.equal(say("clock", { ...clock, hhmm: "14:05", hour: 14, ask: "time" }), "It's 14:05.");
  assert.equal(say("clock", { ...clock, ask: "day" }), "It's Saturday! Weekend vibes!");
  assert.equal(say("clock", { ...clock, weekday: "Tuesday", ask: "day" }, "is it the weekend"), "Not yet, it's Tuesday.");
  assert.equal(say("clock", { ...clock, ask: "date" }), "It's Saturday, the 10th of October.");
  assert.match(say("clock", { ask: "time" }), /confused/);
});

test("ordinals", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"]);
});

test("battery: level, charging, low, unknown", () => {
  assert.equal(say("battery", { level: 64, charging: false, ask: "level" }), "I'm at 64 percent battery.");
  assert.equal(say("battery", { level: 90, charging: false, ask: "level" }), "I'm at 90 percent battery, full of beans!");
  assert.match(say("battery", { level: 12, charging: false, ask: "level" }), /Feed me/);
  assert.equal(say("battery", { level: 40, charging: true, ask: "charging" }), "Yes, I'm charging! Yum, 40 percent so far.");
  assert.equal(say("battery", { level: 40, charging: false, ask: "charging" }), "Nope, not plugged in. I'm at 40 percent.");
  assert.match(say("battery", { ask: "level" }), /can't read/);
});

test("place: near a sight in a district, the satellite excuse, an old fix, no GPS", () => {
  assert.equal(say("place", { looking: true }), LOOKING_LINE);
  assert.equal(
    say("place", { fix: true, ageS: 4, acc: 10, near: "Zwinger", category: "sight", distanceM: 40, district: "Innere Altstadt" }),
    "We're near the Zwinger, in Innere Altstadt!",
  );
  assert.equal(say("place", { fix: false, seen: 2, used: 0 }), "I can't see the sky yet, I hear 2 satellites.");
  assert.match(say("place", { fix: false }), /no satellites/);
  assert.equal(
    say("place", { fix: true, ageS: 600, near: "Zwinger", category: "sight", distanceM: 40, seen: 1 }),
    "Last I knew, 10 minutes ago, we were near the Zwinger. I can't see the sky yet, I hear 1 satellite.",
  );
  assert.equal(say("place", { fix: true, ageS: 3, district: "Klotzsche" }), "We're in Klotzsche!");
  assert.match(say("place", { fix: true, ageS: 3 }), /no named place/);
  assert.match(say("place", { reason: "gpsOff" }), /switched off/);
  assert.match(say("place", { reason: "denied" }), /not allowed/);
});

test("place phrases by category and distance", () => {
  assert.equal(placePhrase("Zwinger", "sight", 40), "near the Zwinger");
  assert.equal(placePhrase("Zwinger", "sight", 300), "about 300 metres from the Zwinger");
  assert.equal(placePhrase("Prager Straße", "street", 20), "on Prager Straße");
  assert.equal(placePhrase("Postplatz", "station", 50), "by the Postplatz stop");
  assert.equal(placePhrase("Café Toscana", "food", 30), "near Café Toscana");
});

test("satellites, height, speed", () => {
  assert.equal(say("sky", { seen: 9, used: 6, best: 38 }), "I hear 9 satellites, and 6 are helping me find us. Clear sky!");
  assert.equal(say("sky", { seen: 5, used: 0, best: 20 }), "I hear 5 satellites, but none locked yet.");
  assert.equal(say("sky", { seen: 0, used: 0, best: 0 }), "No satellites yet. I need to see the open sky!");
  assert.match(say("sky", {}), /can't hear any/);
  assert.equal(say("altitude", { m: 110, acc: 10 }), "We're about 110 metres above sea level!");
  assert.equal(say("altitude", { m: 110, acc: 25 }), "We're about 110 metres above sea level, give or take 25.");
  assert.match(say("altitude", { seen: 3 }), /I hear 3 satellites/);
  assert.equal(say("speed", { fix: true, moving: true, kmh: 4.7, heading: "east" }), "We're walking about 4.7 km per hour, heading east!");
  assert.equal(say("speed", { fix: true, moving: false, kmh: 0.3 }), "We're standing still right now.");
  assert.match(say("speed", { seen: 0 }), /no satellites/);
});

test("dark: the sun's height, plus the light right here", () => {
  assert.equal(say("dark", { sunElevation: -12 }), "It's dark outside, the sun is well down.");
  assert.equal(say("dark", { sunElevation: -3 }), "It's twilight, the sun is just below the horizon.");
  assert.equal(say("dark", { sunElevation: 20, light: "dark" }), "It's daytime, the sun is up! But it's dark right here. Are we indoors?");
  assert.match(say("dark", { sunElevation: -20, light: "bright" }), /lamps on/);
  assert.match(say("dark", {}), /not sure/);
});

test("awake", () => {
  assert.equal(say("awake", { minutes: 185 }), "I've been awake 3 hours and 5 minutes.");
  assert.equal(say("awake", { minutes: 0 }), "I just woke up!");
});

test("respond hands every senses command to senseReply", () => {
  for (const name of SENSE_COMMANDS) {
    const out = respond({ name, args: {}, confidence: 1, text: "x" }, noNotes);
    assert.ok(out.reply.length > 0 && !/not sure how to do that/.test(out.reply), name);
  }
  const out = respond({ name: "battery", args: { level: 50, charging: false }, confidence: 1, text: "how much battery" }, noNotes);
  assert.equal(out.reply, "I'm at 50 percent battery.");
});

test("map strip: satellites while looking", () => {
  assert.equal(gpsStatusText(false, false, { total: 5, used: 0, best: 22 }), "Looking for satellites: 5 seen, 0 locked");
  assert.equal(gpsStatusText(false, false, null), "Finding you · step outside");
  assert.equal(gpsStatusText(false, true, { total: 0, used: 0, best: 0 }), "Lost the sky · step outside");
  assert.equal(gpsStatusText(true, false, { total: 5, used: 0, best: 22 }), "Turn on location");
});
