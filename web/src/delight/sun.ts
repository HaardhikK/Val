// Sunrise, sunset, solar noon, civil twilight (NOAA solar calculator) and the moon's phase, offline and dependency-free.
// Pure math: unit-tested in web/test/sun.test.ts. Times are absolute (Date), so the phone's time zone only matters for display.

export const DRESDEN = { lat: 51.0504, lon: 13.7373 };

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2440587.5; // Julian day of the Unix epoch
const J2000 = 2451545;

const julian = (ms: number) => ms / DAY_MS + J1970;

/** Sun declination (rad) and equation of time (min) at an instant, after NOAA's spreadsheet. */
function solar(ms: number) {
  const t = (julian(ms) - J2000) / 36525; // Julian centuries since J2000
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * RAD); // apparent longitude
  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(obliq * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan((obliq / 2) * RAD) ** 2;
  const eqTime =
    (4 / RAD) *
    (y * Math.sin(2 * l0 * RAD) -
      2 * e * Math.sin(m * RAD) +
      4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD) -
      0.5 * y * y * Math.sin(4 * l0 * RAD) -
      1.25 * e * e * Math.sin(2 * m * RAD));
  return { decl, eqTime };
}

/** Solar noon (UTC ms) on the solar day `day` (days since the epoch, counted at the longitude). */
function noonOn(day: number, lon: number) {
  let ms = day * DAY_MS + (720 - 4 * lon) * 60_000;
  for (let i = 0; i < 2; i++) ms = day * DAY_MS + (720 - 4 * lon - solar(ms).eqTime) * 60_000;
  return ms;
}

/** When the sun's centre crosses `zenith` degrees, before (-1) or after (+1) noon; null if it never does that day. */
function crossing(day: number, noon: number, lat: number, lon: number, zenith: number, side: -1 | 1) {
  let ms = noon;
  for (let i = 0; i < 3; i++) {
    const { decl, eqTime } = solar(ms);
    const cosH = Math.cos(zenith * RAD) / (Math.cos(lat * RAD) * Math.cos(decl)) - Math.tan(lat * RAD) * Math.tan(decl);
    if (cosH < -1 || cosH > 1) return null; // midnight sun or polar night
    const ha = Math.acos(cosH) / RAD;
    ms = day * DAY_MS + (720 - 4 * lon - eqTime + side * 4 * ha) * 60_000;
  }
  return new Date(ms);
}

export interface SunTimes {
  dawn: Date | null; // civil twilight begins (sun 6° below the horizon)
  sunrise: Date | null;
  noon: Date;
  sunset: Date | null;
  dusk: Date | null; // civil twilight ends
}

/** Sun times for the local solar day that contains `at`. */
export function sunTimes(at: Date, lat = DRESDEN.lat, lon = DRESDEN.lon): SunTimes {
  const day = Math.floor(at.getTime() / DAY_MS + lon / 360);
  const noon = noonOn(day, lon);
  return {
    dawn: crossing(day, noon, lat, lon, 96, -1),
    sunrise: crossing(day, noon, lat, lon, 90.833, -1), // refraction and the sun's radius
    noon: new Date(noon),
    sunset: crossing(day, noon, lat, lon, 90.833, 1),
    dusk: crossing(day, noon, lat, lon, 96, 1),
  };
}

export interface MoonPhase {
  /** Lit fraction of the disc, 0 (new) to 1 (full). */
  illumination: number;
  /** 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter. */
  phase: number;
  waxing: boolean;
}

/** Moon phase from low-precision lunar and solar longitudes (good to about 1 % of illumination). */
export function moonPhase(at: Date): MoonPhase {
  const d = julian(at.getTime()) - J2000;
  // Sun's ecliptic longitude.
  const ms = (357.5291 + 0.98560028 * d) * RAD;
  const sunLon = ms + (1.9148 * Math.sin(ms) + 0.02 * Math.sin(2 * ms) + 0.0003 * Math.sin(3 * ms)) * RAD + 102.9372 * RAD + Math.PI;
  // Moon's ecliptic longitude and latitude, with the main periodic terms.
  const lm = (218.316 + 13.176396 * d) * RAD;
  const mm = (134.963 + 13.064993 * d) * RAD;
  const f = (93.272 + 13.22935 * d) * RAD;
  const dEl = lm - (280.46 + 0.9856474 * d) * RAD; // mean elongation
  const moonLon = lm + (6.289 * Math.sin(mm) + 1.274 * Math.sin(2 * dEl - mm) + 0.658 * Math.sin(2 * dEl) - 0.186 * Math.sin(ms)) * RAD;
  const moonLat = 5.128 * Math.sin(f) * RAD;
  const elong = Math.acos(Math.cos(moonLat) * Math.cos(moonLon - sunLon)); // 0..π
  const illumination = (1 - Math.cos(elong)) / 2; // phase angle ≈ π − elongation (the moon is ~390× closer than the sun)
  const ahead = (((moonLon - sunLon) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return { illumination, phase: ahead / (2 * Math.PI), waxing: ahead < Math.PI };
}

/** "42 min", "3 h 5 min". */
export function duration(ms: number) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** The next sunrise or sunset after `now`, looking up to two days ahead (null in polar day or night). */
export function nextSunEvent(now: Date, lat = DRESDEN.lat, lon = DRESDEN.lon) {
  for (let k = -1; k <= 2; k++) {
    const t = sunTimes(new Date(now.getTime() + k * DAY_MS), lat, lon);
    for (const [kind, at] of [["rise", t.sunrise], ["set", t.sunset]] as const) {
      if (at && at.getTime() > now.getTime()) return { kind, at };
    }
  }
  return null;
}

/** The sun card's one line, short enough for a phone's width: "Sunset in 42 min · full moon", "Sunrise in 8 h 11 min · new moon". */
export function sunLine(now: Date, lat = DRESDEN.lat, lon = DRESDEN.lon) {
  const next = nextSunEvent(now, lat, lon);
  const moon = shortMoon(moonPhase(now).phase);
  if (!next) return `No sunrise today · ${moon}`;
  return `${next.kind === "rise" ? "Sunrise" : "Sunset"} in ${duration(next.at.getTime() - now.getTime())} · ${moon}`;
}

const SHORT_MOON = ["new moon", "crescent", "half moon", "gibbous moon", "full moon", "gibbous moon", "half moon", "crescent"];

/** "half moon" for a phase 0..1: the card's short names (moonName has the full ones for speech). */
export function shortMoon(phase: number) {
  return SHORT_MOON[Math.round(phase * 8) % 8];
}

/** "07:15" in the phone's time zone. */
export function clock(d: Date | null) {
  if (!d) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const MOON_NAMES = ["new", "waxing crescent", "first quarter", "waxing gibbous", "full", "waning gibbous", "last quarter", "waning crescent"];

/** "waxing gibbous" for a phase 0..1 (0 = new, 0.5 = full). */
export function moonName(phase: number) {
  return MOON_NAMES[Math.round(phase * 8) % 8];
}

/** "2 hours and 5 minutes", for speaking (the card's "2 h 5 min" reads badly aloud). */
export function spokenDuration(ms: number) {
  const min = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  const rest = min % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (!h) return part(rest, "minute");
  return rest ? `${part(h, "hour")} and ${part(rest, "minute")}` : part(h, "hour");
}

/** What Val says about the sun or the moon, for what was asked: short, cute, plain words for the voice. */
export function sunSpeech(now: Date, asked: string, lat = DRESDEN.lat, lon = DRESDEN.lon) {
  const askedSet = /\b(set|sunset|dark|dusk|night|nightfall|go down)\b/i.test(asked);
  if (/\bmoon\b/i.test(asked)) {
    const m = moonPhase(now);
    const pct = Math.round(m.illumination * 100);
    return `It's a ${moonName(m.phase)} moon, ${pct} percent lit. ${pct < 5 ? "Good night for stars!" : "Pretty!"}`;
  }
  const next = nextSunEvent(now, lat, lon);
  if (!next) return "The sun is taking a day off here.";
  const left = next.at.getTime() - now.getTime();
  const when = `in ${spokenDuration(left)}, at ${clock(next.at)}`;
  if (next.kind === "rise") {
    // Asked about sunset or dark after the sun went down: say so, then when it is back.
    const set = sunTimes(now, lat, lon).sunset;
    if (askedSet && set && set.getTime() < now.getTime()) return `The sun set at ${clock(set)}. It's back ${when}!`;
    return `Sunrise is ${when}. Cosy time till then!`;
  }
  return `Sunset is ${when}. ${left < 3_600_000 ? "Golden hour, quick!" : "Plenty of light left!"}`;
}
