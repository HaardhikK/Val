// Cheap delight: the phone's proximity, light and battery readings → small character reactions.
// Event-driven (no per-frame work) and pure: the character and effects arrive as plain functions, so it is unit-tested
// without three.js. Cooldowns keep a flickering sensor or a loose cable from making the robot jitter.
import type { SensorEvent } from "../bridge";

const PINK = "#ffb3c8";

type Mood = "Angry" | "Surprised" | "Sad";
type Emote = "Wave" | "Yes" | "No" | "ThumbsUp" | "Jump" | "Punch";

/** What reactions may ask of the character (wire to Character methods). */
export interface CharacterApi {
  mood(m: Mood, amount: number): void;
  emote(name: Emote): void;
  hop(): void;
  /** Tuck the head down (0 = normal, 1 = hiding). */
  tuckHead(amount: number): void;
  /** Idle animation speed (1 = normal; lower = sleepy). */
  setPace(k: number): void;
  /** True when the character is free to react (normal mode: not asleep, carried, falling or tumbling). */
  free(): boolean;
}

/** What reactions may ask of the effects layer and the app. */
export interface EffectsApi {
  /** A mono glyph pops over Val's head, cream unless a colour is given. */
  pop(glyph: string, color?: string): void;
  haptic(pattern: "tick" | "bump" | "tumble" | "giggle"): void;
  sunglasses(on: boolean): void;
  lantern(on: boolean): void;
}

export type Schedule = (fn: () => void, ms: number) => void;

/** Tunables (ms unless noted). */
export const REACTION = {
  minHide: 250, // a "near" shorter than this is a flicker: undo quietly, no boo
  maxHide: 20_000, // longer than this it was a pocket or a table, not a game: no boo
  booCooldown: 3_000, // after a boo, the next peekaboo waits this long
  booRelax: 900, // how long the surprised face lasts after a boo
  lightDwell: 8_000, // a light level must have held this long before the look changes again
  nomCooldown: 30_000, // a wobbly charger does not make it eat over and over
  lowBattery: 20, // percent
};

export interface Reactions {
  handle(e: SensorEvent, now?: number): void;
  /** The ambient state for tests and the debug overlay. */
  readonly state: { hiding: boolean; light: "dark" | "normal" | "bright"; lowBattery: boolean };
}

export function createReactions(
  character: CharacterApi,
  effects: EffectsApi,
  schedule: Schedule = (fn, ms) => void setTimeout(fn, ms),
  clock: () => number = () => performance.now(),
): Reactions {
  const state = { hiding: false, light: "normal" as "dark" | "normal" | "bright", lowBattery: false };
  let hideStart = 0;
  let quietUntil = 0; // no new peekaboo before this
  let lightShown: "dark" | "normal" | "bright" = "normal";
  let lightShownAt = -Infinity;
  let lightTimer = false;
  let charging: boolean | null = null;
  let lastNom = -Infinity;
  let sadShown = 0;

  /** Sleepy (dark) and droopy (low battery) both lower the face; the stronger one wins. */
  function ambient() {
    const sad = Math.max(lightShown === "dark" ? 0.3 : 0, state.lowBattery ? 0.4 : 0);
    const pace = Math.min(lightShown === "dark" ? 0.6 : 1, state.lowBattery ? 0.8 : 1);
    if (!state.hiding && (sad > 0 || sadShown > 0)) character.mood("Sad", sad); // never clear a mood we did not set
    sadShown = sad;
    character.setPace(pace);
  }

  function showLight(now: number) {
    if (state.light === lightShown) return;
    const was = lightShown;
    lightShown = state.light;
    lightShownAt = now;
    effects.lantern(lightShown === "dark");
    effects.sunglasses(lightShown === "bright");
    if (lightShown === "bright" && character.free()) character.emote("ThumbsUp"); // "nice and sunny"
    if (lightShown === "dark" && was !== "dark") effects.pop("☾");
    ambient();
  }

  function onLight(level: "dark" | "normal" | "bright", now: number) {
    state.light = level;
    const wait = lightShownAt + REACTION.lightDwell - now;
    if (wait <= 0) return showLight(now);
    if (lightTimer) return; // one pending check; it applies whatever the latest level is by then
    lightTimer = true;
    schedule(() => {
      lightTimer = false;
      showLight(clock());
    }, wait);
  }

  function onProximity(isNear: boolean, now: number) {
    if (isNear) {
      if (state.hiding || now < quietUntil || !character.free()) return;
      state.hiding = true;
      hideStart = now;
      character.mood("Surprised", 0.6); // "where did you go?"
      character.tuckHead(1);
      return;
    }
    if (!state.hiding) return;
    state.hiding = false;
    character.tuckHead(0);
    const held = now - hideStart;
    if (held >= REACTION.minHide && held <= REACTION.maxHide && character.free()) {
      character.mood("Surprised", 1);
      character.hop();
      effects.pop("!", PINK);
      effects.haptic("giggle");
      quietUntil = now + REACTION.booCooldown;
      schedule(() => {
        if (!state.hiding) {
          character.mood("Surprised", 0);
          sadShown = 0;
          ambient();
        }
      }, REACTION.booRelax);
    } else {
      character.mood("Surprised", 0);
      sadShown = 0;
      ambient();
    }
  }

  function onBattery(level: number, isCharging: boolean, now: number) {
    const low = level < REACTION.lowBattery && !isCharging;
    const pluggedIn = charging === false && isCharging; // only a real change, not the first reading
    charging = isCharging;
    if (low !== state.lowBattery) {
      state.lowBattery = low;
      if (!state.hiding) ambient();
    }
    if (pluggedIn && now - lastNom >= REACTION.nomCooldown) {
      lastNom = now;
      effects.pop("ϟ", PINK);
      effects.haptic("tick");
      if (character.free()) character.emote("Yes"); // "nom"
    }
  }

  return {
    state,
    handle(e, now = clock()) {
      switch (e.type) {
        case "proximity":
          return onProximity(e.near, now);
        case "light":
          return onLight(e.level, now);
        case "battery":
          return onBattery(e.level, e.charging, now);
      }
    },
  };
}
