// The voice side of trams and buses: where we are (a GPS fix, waited for), where home is (kept on the phone only),
// and Val's lines for the cases with no journey. Pure apart from timers; unit-tested.
import type { LatLon } from "./api";

/** A fix this recent and this accurate is used at once. */
export const FRESH_FIX_MS = 30_000;
export const GOOD_FIX_M = 100;
/** How long a trip question waits for GPS before falling back to an older fix. */
export const FIX_WAIT_MS = 30_000;
/** The oldest fix a trip may start from (people move: older than this, the plan starts somewhere else). */
export const OLD_FIX_MS = 10 * 60_000;

export const LINES = {
  noHome: "Tell me \"this is my home\" when you're there!",
  noFix: "I can't see the sky from here. Step outside for a moment and ask me again!",
  gpsOff: "Turn on location so I can find us first.",
  looking: "Looking for the sky…",
  homeSaved: "Got it, this is home now! Say \"get me home\" any time.",
  homeNeedsFix: "I need to see the sky to save home. Step outside and tell me again!",
  noTimetable: "I don't have the tram timetable yet.",
  whichStop: "Which stop? Say \"next tram at Postplatz\".",
  noDest: "Where do you want to go?",
} as const;

/**
 * When a fix was really taken, on the clock that gives [now]: the app sends the chip's last known fix (up to 10 min
 * old) with its age, so an old fix never counts as fresh. A missing or bad age means "just now".
 */
export const fixTime = (now: number, ageMs?: number) => now - (ageMs !== undefined && Number.isFinite(ageMs) && ageMs > 0 ? ageMs : 0);

export interface Fix extends LatLon {
  acc: number;
  at: number;
}

export type Located = { fix: Fix; old: boolean } | { error: "off" | "none" };

/**
 * The latest GPS fix and the questions waiting for one. A question takes a fresh, good fix at once; otherwise it
 * waits up to FIX_WAIT_MS for one, then takes the last fix up to OLD_FIX_MS old, else gives up.
 */
export class Locator {
  private last: Fix | null = null;
  private waiters = new Set<(r: Located) => void>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** [ageMs]: how old the fix already was when the app sent it (see [fixTime]). */
  feed(lat: number, lon: number, acc: number, ageMs?: number) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    const fix = { lat, lon, acc: Number.isFinite(acc) ? acc : 999, at: fixTime(this.now(), ageMs) };
    if (this.last && fix.at < this.last.at) return; // an older fix never replaces a newer one
    this.last = fix;
    if (this.within(FRESH_FIX_MS, true) === fix) for (const w of [...this.waiters]) w({ fix, old: false });
  }

  /** Location is switched off or not allowed: waiting questions end now (with an older fix if there is one). */
  fail() {
    const old = this.within(OLD_FIX_MS);
    for (const w of [...this.waiters]) w(old ? { fix: old, old: true } : { error: "off" });
  }

  private within(ms: number, good = false): Fix | null {
    const f = this.last;
    if (!f || this.now() - f.at > ms || (good && f.acc > GOOD_FIX_M)) return null;
    return f;
  }

  /** `onWait` runs only when there is no fresh fix (to say "looking for the sky"). */
  locate(waitMs = FIX_WAIT_MS, onWait?: () => void): Promise<Located> {
    const fresh = this.within(FRESH_FIX_MS, true);
    if (fresh) return Promise.resolve({ fix: fresh, old: false });
    onWait?.();
    return new Promise((resolve) => {
      const done = (r: Located) => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(r);
      };
      const timer = setTimeout(() => {
        const old = this.within(OLD_FIX_MS);
        done(old ? { fix: old, old: true } : { error: "none" });
      }, waitMs);
      this.waiters.add(done);
    });
  }
}

/** Val's line when no fix could be found. */
export const locateLine = (r: Extract<Located, { error: string }>) => (r.error === "off" ? LINES.gpsOff : LINES.noFix);

// ---- Home: one place, in this phone's localStorage only (never sent anywhere, never logged) ----

export const HOME_KEY = "charm.home";

type Store = Pick<Storage, "getItem" | "setItem">;

function storage(): Store | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function loadHome(store: Store | null = storage()): LatLon | null {
  try {
    const v = JSON.parse(store?.getItem(HOME_KEY) ?? "null");
    const ok = v && Number.isFinite(v.lat) && Number.isFinite(v.lon) && Math.abs(v.lat) <= 90 && Math.abs(v.lon) <= 180;
    return ok ? { lat: v.lat, lon: v.lon } : null;
  } catch {
    return null;
  }
}

/** Saves home; false when storage is unavailable. Coordinates are rounded to ~1 m. */
export function saveHome(p: LatLon, store: Store | null = storage()): boolean {
  if (!store) return false;
  try {
    store.setItem(HOME_KEY, JSON.stringify({ lat: Math.round(p.lat * 1e5) / 1e5, lon: Math.round(p.lon * 1e5) / 1e5 }));
    return true;
  } catch {
    return false;
  }
}
