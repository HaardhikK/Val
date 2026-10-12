// Which feature owns the screen (camera, map, metal detector), as a pure state machine (no DOM, unit-tested).
// One feature at a time, logically: opening B while A is open or revealing closes A fully first (Val stows A's prop,
// tilt unlocks), and only then does B's reveal start. main.ts runs the effects and feeds back what happened.

export type FeatureKind = "camera" | "map" | "metal";
export type FeaturePhase = "home" | "revealing" | "open" | "closing";

export interface FeatureRequest {
  kind: FeatureKind;
  /** Map only: a place to search and route to. */
  place?: string;
  /** Map only: by tram/bus to a place ("home" = the saved home); wins over `place`. */
  trip?: { dest: string; mode: string; heard?: string };
}

export interface FeatureState {
  phase: FeaturePhase;
  /** The request being revealed, open or closing (null at home). */
  req: FeatureRequest | null;
  /** Bumped on every reveal: async results from an older one are ignored. */
  token: number;
  /** A request waiting for the current feature to close (or for Val to finish stowing). */
  queued: FeatureRequest | null;
}

export type FeatureEvent =
  | { type: "request"; req: FeatureRequest }
  /** The reveal finished and the feature is showing (camera: first frame up; map: Val holds the unrolled scroll). */
  | { type: "revealed"; token: number }
  /** Close whatever is open or revealing (volume press, "stop"); also drops a queued request. */
  | { type: "back"; spoken?: boolean }
  /** The feature began closing on its own (its close button, a swipe). */
  | { type: "closing"; kind: FeatureKind }
  /** The feature has fully closed. */
  | { type: "closed"; kind: FeatureKind }
  /** Val has put the old prop away: a queued feature may start. */
  | { type: "settled" };

export type FeatureEffect =
  | { do: "reveal"; req: FeatureRequest; token: number }
  | { do: "show"; req: FeatureRequest; token: number }
  | { do: "close"; kind: FeatureKind; spoken: boolean }
  | { do: "end"; kind: FeatureKind }
  | { do: "settle"; ms: number }
  | { do: "shutter" }
  | { do: "goTo"; place: string }
  | { do: "trip"; trip: NonNullable<FeatureRequest["trip"]> }
  | { do: "note"; text: string };

/** Val's prop stow (REVEAL.stowMs) plus a beat, before a queued feature's reveal starts. */
export const SETTLE_MS = 260;

export const homeState = (): FeatureState => ({ phase: "home", req: null, token: 0, queued: null });

/** "home", "revealing(map)", … for the transition log. */
export function featureLabel(s: FeatureState): string {
  return s.phase === "home" || !s.req ? "home" : `${s.phase}(${s.req.kind})`;
}

export const FEATURE_KINDS: readonly FeatureKind[] = ["camera", "map", "metal"];

/**
 * The features whose overlay must not be up in this state: every one but the current (revealing, open or closing)
 * feature. main.ts tears down any that still are after each dispatch, so closing the camera can only ever land on
 * Val at home, never on a map left behind or opened late.
 */
export function mustBeDown(s: FeatureState): FeatureKind[] {
  const keep = s.phase === "home" ? null : s.req?.kind;
  return FEATURE_KINDS.filter((k) => k !== keep);
}

/** Whether Val's own touch, knock and wander reactions are off (a feature is revealing, open or closing). */
export const featureBusy = (s: FeatureState) => s.phase !== "home";

type Out = { state: FeatureState; effects: FeatureEffect[] };
const note = (state: FeatureState, text: string): Out => ({ state, effects: [{ do: "note", text }] });

export function featureStep(s: FeatureState, e: FeatureEvent): Out {
  switch (e.type) {
    case "request": {
      const r = e.req;
      if (s.phase === "home") {
        if (s.queued) return note({ ...s, queued: r }, `queued ${r.kind} (waiting for the stow)`);
        const token = s.token + 1;
        return { state: { phase: "revealing", req: r, token, queued: null }, effects: [{ do: "reveal", req: r, token }] };
      }
      const cur = s.req!;
      if (s.phase === "closing") return note({ ...s, queued: r }, `queued ${r.kind} (${cur.kind} is closing)`);
      if (cur.kind === r.kind) {
        if (s.phase === "revealing") {
          if (r.kind === "map" && (r.place || r.trip)) return note({ ...s, req: r }, `map ${r.trip ? "trip" : "place"} updated while revealing`);
          return note(s, `ignored ${r.kind} (already revealing)`);
        }
        if (r.kind === "camera") return { state: s, effects: [{ do: "shutter" }] };
        if (r.kind === "map" && r.trip) return { state: { ...s, req: r }, effects: [{ do: "trip", trip: r.trip }] };
        if (r.kind === "map" && r.place) return { state: { ...s, req: r }, effects: [{ do: "goTo", place: r.place }] };
        return note(s, `ignored ${r.kind} (already open)`);
      }
      return {
        state: { ...s, phase: "closing", queued: r },
        effects: [{ do: "note", text: `queued ${r.kind} (closing ${cur.kind} first)` }, { do: "close", kind: cur.kind, spoken: false }],
      };
    }
    case "revealed":
      if (s.phase !== "revealing" || e.token !== s.token) return note(s, `ignored stale reveal ${e.token}`);
      return { state: { ...s, phase: "open" }, effects: [{ do: "show", req: s.req!, token: s.token }] };
    case "back":
      if (s.phase === "home") return note({ ...s, queued: null }, "back: nothing open");
      if (s.phase === "closing") return note({ ...s, queued: null }, `back: ${s.req!.kind} already closing`);
      return { state: { ...s, phase: "closing", queued: null }, effects: [{ do: "close", kind: s.req!.kind, spoken: !!e.spoken }] };
    case "closing":
      if (s.phase === "home" || s.req?.kind !== e.kind) return note(s, `ignored stale closing ${e.kind}`);
      return { state: { ...s, phase: "closing" }, effects: [] };
    case "closed": {
      if (s.phase === "home" || s.req?.kind !== e.kind) return note(s, `ignored stale closed ${e.kind}`);
      const effects: FeatureEffect[] = [{ do: "end", kind: e.kind }];
      if (s.queued) effects.push({ do: "settle", ms: SETTLE_MS });
      return { state: { phase: "home", req: null, token: s.token, queued: s.queued }, effects };
    }
    case "settled": {
      if (s.phase !== "home" || !s.queued) return { state: s, effects: [] };
      const token = s.token + 1;
      const r = s.queued;
      return { state: { phase: "revealing", req: r, token, queued: null }, effects: [{ do: "reveal", req: r, token }] };
    }
  }
}
