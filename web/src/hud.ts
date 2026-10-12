// The voice overlays: the transcript card (YOU ▸ / VAL ▸, typed out) and the tape-recorder strip
// (REC + live mic meter, THINKING scan, SPEAKING). Markup and look live in web/index.html.
// Animations use transform and opacity only; the typed reply rewrites one text node per tick.

export const METER_BARS = 12;
const CHAR_MS = 25;
const MAX_TYPE_MS = 1500;
const HEARD_MAX = 90;

/** Replies above this many characters type in a smaller size (index.html, #bubble.long). */
export const LONG_REPLY = 140;

/**
 * Cap a transcript at `max` characters, cutting at a word break when one is near, with an ellipsis. With
 * `sentences`, a cut at the last sentence end in the second half wins (no ellipsis needed there).
 */
export function truncate(text: string, max = HEARD_MAX, sentences = false): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  if (sentences) {
    const ends = t.slice(0, max + 1).match(/^.*[.!?](?=\s)/);
    if (ends && ends[0].length > max * 0.5) return ends[0];
  }
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?]+$/, "")}…`;
}

/** Mic level smoothing: rises fast (follows a syllable), falls slowly (no flicker). Inputs are clamped to 0..1. */
export function smoothLevel(prev: number, next: number): number {
  const v = Math.min(1, Math.max(0, Number.isFinite(next) ? next : 0));
  return v > prev ? prev + (v - prev) * 0.7 : prev + (v - prev) * 0.3;
}

/** Characters revealed per tick so a reply types at 25 ms per char but never takes longer than 1.5 s. */
export function charsPerTick(length: number): number {
  return Math.max(1, Math.ceil((length * CHAR_MS) / MAX_TYPE_MS));
}

/** Typing in time with the voice: never faster than this, so a short chunk with a tiny ms still reads as typing. */
export const MIN_SPOKEN_CHAR_MS = 15;

/** Characters of a spoken chunk shown after `elapsedMs`, so typing ends when the chunk's audio (`ms` long) ends. */
export function spokenChars(elapsedMs: number, chars: number, ms: number): number {
  if (chars <= 0) return 0;
  const perChar = Math.max(MIN_SPOKEN_CHAR_MS, (Number.isFinite(ms) ? ms : 0) / chars);
  return Math.min(chars, Math.max(0, Math.floor(elapsedMs / perChar)));
}

/** Voice on (spoken replies) or off (text only), kept in localStorage; storage that throws or is missing means "on". */
export interface VoiceSetting {
  readonly on: boolean;
  set(on: boolean): void;
}

const VOICE_KEY = "charm.voice";

export function voiceSetting(storage: Pick<Storage, "getItem" | "setItem"> | null = safeLocalStorage()): VoiceSetting {
  let on = true;
  try {
    on = storage?.getItem(VOICE_KEY) !== "off";
  } catch {
    on = true;
  }
  return {
    get on() {
      return on;
    },
    set(next) {
      on = next;
      try {
        storage?.setItem(VOICE_KEY, next ? "on" : "off");
      } catch {
        // private mode or blocked storage: the setting lasts until the page reloads
      }
    },
  };
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export type EarsState = "off" | "listening" | "thinking" | "speaking";

export interface VoiceHud {
  /** Show the transcript card; `heard` may be empty (Val speaking on his own). */
  show(heard: string, said: string, holdMs?: number): void;
  /** Card up with what was heard and an empty reply: [chunk] types `said` in time with the voice. */
  prepare(heard: string, said: string): void;
  /** Type one spoken chunk over `ms` (it starts playing now); ignored unless a reply is prepared. */
  chunk(text: string, ms: number): void;
  /** The voice is about to say characters up to [end] of the current chunk: type exactly that far (word-exact sync). */
  word(end: number): void;
  /** The voice finished: show the whole prepared reply at once (nothing is ever left untyped). */
  finish(): void;
  /** The voice is late or failed: type the prepared reply the normal way. Returns false if none was waiting. */
  typeNow(holdMs?: number): boolean;
  /** Forget the prepared reply (the user started talking over it). */
  drop(): void;
  /** True while a prepared reply waits for, or is typed with, the voice. */
  readonly streaming: boolean;
  setMuted(muted: boolean): void;
  /** A dim FACT tag next to Val's name: this reply came from Val's fact cards, not the model. */
  setFact(on: boolean): void;
  /** A small pink [OOPS] tag next to Val's name: this card says something went wrong. */
  setError(on: boolean): void;
  setEars(state: EarsState): void;
  /** Keep the card up while Val speaks; [release] hides it a moment after the voice stops. */
  hold(): void;
  release(afterMs?: number): void;
  /** A raw mic level 0..1 from the app (~15 Hz while listening). */
  level(v: number): void;
  readonly ears: EarsState;
}

export function createVoiceHud(doc: Document = document): VoiceHud {
  const bubble = doc.getElementById("bubble")!;
  const heardRow = doc.getElementById("heard")!;
  const heardText = doc.getElementById("heard-text")!;
  const saidText = doc.getElementById("said-text")!;
  const cursor = bubble.querySelector<HTMLElement>(".cursor")!;
  const factTag = bubble.querySelector<HTMLElement>(".fact");
  const errTag = bubble.querySelector<HTMLElement>(".err");
  const said = doc.getElementById("said")!;
  /** Type the reply so far; a long one scrolls so the newest line stays in the card. */
  const setSaid = (text: string) => {
    saidText.textContent = text;
    if (said.scrollHeight > said.clientHeight) said.scrollTop = said.scrollHeight;
  };
  const ears = doc.getElementById("ears")!;
  const label = ears.querySelector<HTMLElement>(".label")!;
  const meter = ears.querySelector<HTMLElement>(".meter")!;
  const bars: HTMLElement[] = [];
  for (let i = 0; i < METER_BARS; i++) {
    const bar = doc.createElement("i");
    bar.style.animationDelay = `${(i * 0.1).toFixed(1)}s`; // the THINKING scan: one bar lit at a time, left to right
    meter.appendChild(bar);
    bars.push(bar);
  }
  const history = new Array<number>(METER_BARS).fill(0);
  let smoothed = 0;
  let state: EarsState = "off";
  let typeTimer: number | undefined;
  let current: { base: string; text: string } | null = null; // the chunk being spoken
  let hideTimer: number | undefined;

  const resetMeter = () => {
    smoothed = 0;
    history.fill(0);
    for (const b of bars) b.style.transform = "";
  };

  // A reply prepared for the voice: typed chunk by chunk as each one starts playing.
  let pending: { heard: string; said: string } | null = null;
  let typed = ""; // text of the chunks already typed in full

  const openCard = (heard: string, reply: string) => {
    bubble.classList.toggle("long", reply.length > LONG_REPLY);
    said.scrollTop = 0;
    const h = truncate(heard); // as heard (trimmed): proper nouns keep their capitals
    heardText.textContent = h;
    heardRow.hidden = !h;
    clearInterval(typeTimer);
    saidText.textContent = "";
    cursor.hidden = false;
    bubble.classList.add("show");
    clearTimeout(hideTimer);
  };

  const show = (heard: string, reply: string, holdMs = 4500) => {
    pending = null;
    openCard(heard, reply);
    const step = charsPerTick(reply.length);
    let n = 0;
    typeTimer = window.setInterval(() => {
      n = Math.min(reply.length, n + step);
      setSaid(reply.slice(0, n));
      if (n >= reply.length) {
        clearInterval(typeTimer);
        cursor.hidden = true;
      }
    }, CHAR_MS);
    hideTimer = window.setTimeout(() => bubble.classList.remove("show"), holdMs + Math.min(reply.length * CHAR_MS, MAX_TYPE_MS));
  };

  return {
    get ears() {
      return state;
    },
    get streaming() {
      return pending !== null;
    },
    show,
    prepare(heard, said) {
      openCard(heard, said);
      pending = { heard, said };
      typed = "";
    },
    word(end) {
      if (!pending || !current) return;
      clearInterval(typeTimer); // word timing from the engine replaces the estimated typing rate
      setSaid(current.base + current.text.slice(0, Math.min(end, current.text.length)));
    },
    chunk(text, ms) {
      if (!pending) return;
      clearInterval(typeTimer);
      const base = typed ? `${typed} ` : "";
      current = { base, text };
      const start = performance.now();
      const tick = () => {
        const n = spokenChars(performance.now() - start, text.length, ms);
        setSaid(base + text.slice(0, n));
        if (n >= text.length) clearInterval(typeTimer);
      };
      typed = base + text; // the audio has moved on: the next chunk starts after this one in full
      tick();
      typeTimer = window.setInterval(tick, CHAR_MS);
    },
    finish() {
      if (!pending) return;
      clearInterval(typeTimer);
      setSaid(pending.said);
      cursor.hidden = true;
      pending = null;
    },
    typeNow(holdMs) {
      if (!pending) return false;
      show(pending.heard, pending.said, holdMs);
      return true;
    },
    drop() {
      pending = null;
    },
    setMuted(muted) {
      ears.classList.toggle("muted", muted);
    },
    setFact(on) {
      if (factTag) factTag.hidden = !on;
    },
    setError(on) {
      if (errTag) errTag.hidden = !on;
    },
    hold() {
      clearTimeout(hideTimer);
    },
    release(afterMs = 1500) {
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => bubble.classList.remove("show"), afterMs);
    },
    setEars(next) {
      if (next === state) return;
      state = next;
      ears.classList.toggle("on", next !== "off");
      ears.classList.toggle("listening", next === "listening");
      ears.classList.toggle("thinking", next === "thinking");
      if (next !== "off") label.textContent = next === "speaking" ? "▶ Speaking" : next === "thinking" ? "Thinking" : "";
      resetMeter();
    },
    level(v) {
      if (state !== "listening") return;
      smoothed = smoothLevel(smoothed, v);
      history.shift();
      history.push(smoothed);
      // Newest level enters on the right and scrolls left, like a tape running past the head.
      for (let i = 0; i < METER_BARS; i++) bars[i].style.transform = `scaleY(${(0.12 + 0.88 * history[i]).toFixed(2)})`;
    },
  };
}
