// What Val says about its world: the app fills each senses command with the phone's own readings (Senses.kt) and
// this turns them into one short, cute line. Never invents a value: anything missing is said to be unknown.
// Pure logic: unit-tested in web/test/senses.test.ts.
import type { Outcome } from "./assistant";
import { spokenDuration } from "./delight/sun";

type Args = Record<string, unknown>;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, 60) : undefined);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const nod = (reply: string): Outcome => ({ action: { kind: "nod" }, reply });
const shrug = (reply: string): Outcome => ({ action: { kind: "shrug" }, reply });

/** Said while the app switches GPS on and waits for a fix. */
export const LOOKING_LINE = "Let me peek at the sky… one moment!";

/** The commands this module answers (SenseFormat.COMMANDS in Senses.kt). */
export const SENSE_COMMANDS = new Set(["clock", "battery", "place", "sky", "altitude", "speed", "dark", "awake"]);

export function senseReply(name: string, a: Args, asked = ""): Outcome {
  switch (name) {
    case "clock":
      return clock(a, asked);
    case "battery":
      return battery(a);
    case "place":
      return place(a);
    case "sky":
      return sky(a);
    case "altitude":
      return altitude(a);
    case "speed":
      return speed(a);
    case "dark":
      return dark(a);
    case "awake":
      return awake(a);
    default:
      return shrug("I'm not sure how to do that yet.");
  }
}

function clock(a: Args, asked: string): Outcome {
  const hhmm = str(a.hhmm);
  const weekday = str(a.weekday);
  if (!hhmm || !weekday) return shrug("My clock is a bit confused right now.");
  const weekend = weekday === "Saturday" || weekday === "Sunday";
  if (a.ask === "day") {
    if (/weekend/i.test(asked)) return nod(weekend ? `Yes! It's ${weekday}, weekend time!` : `Not yet, it's ${weekday}.`);
    return nod(`It's ${weekday}!${weekend ? " Weekend vibes!" : ""}`);
  }
  if (a.ask === "date") {
    const day = num(a.day);
    const month = str(a.month);
    return day && month ? nod(`It's ${weekday}, the ${ordinal(day)} of ${month}.`) : shrug("My calendar is a bit confused right now.");
  }
  const hour = num(a.hour) ?? -1;
  const tail = hour >= 22 || (hour >= 0 && hour < 5) ? " Getting late, sleepyhead!" : hour >= 5 && hour < 10 ? " Good morning!" : "";
  return nod(`It's ${hhmm}.${tail}`);
}

/** 1 → "1st", 22 → "22nd", 13 → "13th". */
export function ordinal(n: number) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

function battery(a: Args): Outcome {
  const level = num(a.level);
  const charging = typeof a.charging === "boolean" ? a.charging : undefined;
  if (level === undefined) return shrug("I can't read my battery right now.");
  if (a.ask === "charging" && charging !== undefined) {
    return charging ? nod(`Yes, I'm charging! Yum, ${level} percent so far.`) : nod(`Nope, not plugged in. I'm at ${level} percent.`);
  }
  if (charging) return nod(`I'm at ${level} percent and charging. Yum!`);
  if (level < 20) return { action: { kind: "shrug" }, reply: `Only ${level} percent left. Feed me soon, please!` };
  return { action: { kind: "thumbs" }, reply: `I'm at ${level} percent battery${level >= 80 ? ", full of beans!" : "."}` };
}

/** When GPS cannot help: switched off, not allowed, or no satellites. */
function noGps(a: Args): Outcome | null {
  if (a.reason === "gpsOff") return shrug("My location is switched off. Turn it on and ask me again!");
  if (a.reason === "denied") return shrug("I'm not allowed to use location yet. Say yes when the phone asks!");
  return null;
}

/** "I can't see the sky yet — I hear 2 satellites." */
function skyExcuse(a: Args): string {
  const seen = num(a.seen);
  if (seen === undefined || seen === 0) return "I can't see the sky yet, no satellites in sight. Let's step outside!";
  return `I can't see the sky yet, I hear ${plural(seen, "satellite")}.`;
}

/** "near the Zwinger", "on Prager Straße", "by the Postplatz stop", "about 300 metres from the Zwinger". */
export function placePhrase(name: string, category: string | undefined, distanceM: number | undefined) {
  const the = category === "sight" || category === "building" || category === "park" || category === "university" || category === "hospital";
  if (category === "street") return distanceM !== undefined && distanceM > 100 ? `near ${name}` : `on ${name}`;
  const what = category === "station" ? `the ${name} stop` : the ? `the ${name}` : name;
  if (distanceM !== undefined && distanceM > 150) return `about ${distanceM} metres from ${what}`;
  return category === "station" ? `by ${what}` : `near ${what}`;
}

function place(a: Args): Outcome {
  if (a.looking === true) return nod(LOOKING_LINE);
  const off = noGps(a);
  if (off) return off;
  if (a.fix !== true) return shrug(skyExcuse(a));
  const near = str(a.near);
  const district = str(a.district);
  const where = near ? placePhrase(near, str(a.category), num(a.distanceM)) : district ? `in ${district}` : "";
  const inDistrict = near && district ? `, in ${district}` : "";
  const ageS = num(a.ageS) ?? 0;
  if (!where) return shrug("I can see us on GPS, but there's no named place near us on my map.");
  if (ageS > 120) {
    const ago = spokenDuration(ageS * 1000);
    return shrug(`Last I knew, ${ago} ago, we were ${where}${inDistrict}. ${num(a.seen) !== undefined ? skyExcuse(a) : ""}`.trim());
  }
  return nod(`We're ${where}${inDistrict}!`);
}

function sky(a: Args): Outcome {
  const off = noGps(a);
  if (off) return off;
  const seen = num(a.seen);
  const used = num(a.used) ?? 0;
  if (seen === undefined) return shrug("I can't hear any satellites right now.");
  if (seen === 0) return shrug("No satellites yet. I need to see the open sky!");
  if (used === 0) return shrug(`I hear ${plural(seen, "satellite")}, but none locked yet.`);
  if (used >= 4) return { action: { kind: "thumbs" }, reply: `I hear ${plural(seen, "satellite")}, and ${used} are helping me find us. Clear sky!` };
  return nod(`I hear ${plural(seen, "satellite")}, ${used} locked so far.`);
}

function altitude(a: Args): Outcome {
  if (a.looking === true) return nod(LOOKING_LINE);
  const off = noGps(a);
  if (off) return off;
  const m = num(a.m);
  if (m === undefined) return shrug(skyExcuse(a));
  const acc = num(a.acc);
  return nod(`We're about ${m} metres above sea level${acc !== undefined && acc >= 20 ? `, give or take ${acc}.` : "!"}`);
}

function speed(a: Args): Outcome {
  if (a.looking === true) return nod(LOOKING_LINE);
  const off = noGps(a);
  if (off) return off;
  if (a.fix !== true) return shrug(skyExcuse(a));
  if (a.moving !== true) return nod("We're standing still right now.");
  const kmh = num(a.kmh);
  if (kmh === undefined) return shrug("I can't tell how fast we're going.");
  const heading = str(a.heading);
  const way = heading ? `, heading ${heading}` : "";
  return nod(kmh > 8 ? `Whee, we're zooming at about ${kmh} km per hour${way}!` : `We're walking about ${kmh} km per hour${way}!`);
}

function dark(a: Args): Outcome {
  const e = num(a.sunElevation);
  if (e === undefined) return shrug("I'm not sure right now.");
  const light = str(a.light);
  const base = e < -6 ? "It's dark outside, the sun is well down." : e < 0 ? "It's twilight, the sun is just below the horizon." : "It's daytime, the sun is up!";
  let extra = "";
  if (e >= 0 && light === "dark") extra = " But it's dark right here. Are we indoors?";
  else if (e >= 0 && light === "bright") extra = " And it's nice and bright here.";
  else if (e < 0 && light === "bright") extra = " It's bright right here though, lamps on!";
  return nod(base + extra);
}

function awake(a: Args): Outcome {
  const min = num(a.minutes);
  if (min === undefined) return shrug("I lost track of time!");
  if (min < 1) return { action: { kind: "wave" }, reply: "I just woke up!" };
  return nod(`I've been awake ${spokenDuration(min * 60_000)}.`);
}
