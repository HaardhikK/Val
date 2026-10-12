// What Val (the character) does with what the user said. The app routes every utterance (Router.kt):
// - an action ("command": keyword rules or Needle, confidence already checked) → act it out with a template reply;
// - anything else → the on-phone chat model answers; the app sends "thinking" (warming or not) and then "answer".
// Pure logic: unit-tested.
import { sunSpeech } from "./delight/sun";
import { LINES as METAL_LINES } from "./metal";
import { cleanLabel, spoken, TIMER, type TimerSnapshot } from "./timer";
import { SENSE_COMMANDS, senseReply } from "./senses";
import { truncate } from "./hud";
import { LINES as TRIP_LINES } from "./transit/trip";

/** The longest answer Val shows and says; longer ones end at their last whole sentence (or word) before it. */
export const MAX_REPLY = 300;

export interface Command {
  name: string;
  args: Record<string, unknown>;
  confidence: number;
  text: string; // what the user said
}

export type Action =
  | { kind: "none" }
  | { kind: "dance" }
  | { kind: "timer"; seconds: number; label?: string; focus?: boolean }
  | { kind: "timerOp"; op: "cancel" | "add" | "pause" | "resume"; seconds?: number }
  /** `heard`: the app was unsure of the place; the map routes to the best guess and asks "did you mean?". */
  | { kind: "map"; place: string | null; heard?: string }
  | { kind: "camera" }
  | { kind: "sun" }
  | { kind: "nod" }
  | { kind: "shrug" }
  | { kind: "wave" }
  | { kind: "hop" }
  | { kind: "thumbs" }
  | { kind: "voice"; on: boolean }
  | { kind: "metal"; on: boolean }
  /** Trams and buses (main.ts runs these: they wait for GPS and the timetable, then say their own line). */
  | { kind: "transit"; dest: string; mode: string; heard?: string }
  | { kind: "departures"; stop: string; mode: string }
  | { kind: "setHome" };

export interface Outcome {
  action: Action;
  reply: string;
}

export interface Notes {
  all(): string[];
  add(text: string): void;
}

/**
 * How long the page waits for an answer once the model is loaded: the app's own limit (sent as `ms` with "thinking",
 * Chat.kt chatReadMs) plus a margin, so the app's answer or error normally arrives first.
 */
export const ANSWER_MARGIN_MS = 1500;
/** Used when the app sends no limit; the app's default is 6.5 s, so 8 s in all. */
export const DEFAULT_ANSWER_MS = 6500;
/** While the model is still loading (cold start), the page waits this long before giving up. */
export const WARMING_TIMEOUT_MS = 45_000;

export const WARMING_LINE = "Warming up my brain…";

/** How long to wait after a "thinking" message from the app. */
export function answerWait(e: Record<string, unknown>): number {
  if (e.warming === true) return WARMING_TIMEOUT_MS;
  const ms = Number(e.ms);
  return (Number.isFinite(ms) && ms > 0 && ms <= 30_000 ? ms : DEFAULT_ANSWER_MS) + ANSWER_MARGIN_MS;
}

/** The app's "answer" message → what Val says. Errors and timeouts get a friendly line (the reason goes to the log). */
export function answerReply(e: Record<string, unknown>): { ok: boolean; reply: string } {
  const text = typeof e.reply === "string" ? truncate(e.reply, MAX_REPLY, true) : "";
  if (e.ok === true && text) return { ok: true, reply: text };
  return { ok: false, reply: fallbackReply(String(e.reason ?? "")) };
}

/** Friendly words for a failed answer. */
export function fallbackReply(reason: string): string {
  if (/busy question/.test(reason)) return "I'm still thinking about your last question. One moment!";
  if (/busy/.test(reason)) return "I'm still busy with your photo. Ask me again in a moment!";
  if (/missing/.test(reason)) return "My thinking brain isn't on the phone yet.";
  if (/timeout|page/.test(reason)) return "Hmm, that one made my head spin. Can you ask me again?";
  return "Oops, I lost my train of thought. Try asking again?";
}

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

// ---- Small talk: Val's fixed, warm replies (Router.kt sends "smalltalk" with a kind); a few variants each ----

type SmallTalk = { action: Action; lines: string[] };

export const SMALL_TALK: Record<string, SmallTalk> = {
  greet: { action: { kind: "wave" }, lines: ["Hi! I'm Val. So happy to see you!", "Hello hello! Val here, ready to play.", "Hey there! What shall we do today?"] },
  how_are_you: {
    action: { kind: "thumbs" },
    lines: ["I'm great, thanks! I'm Val, your pocket robot. How are you?", "I'm doing wonderful, all charged up! How about you?", "Feeling bouncy today! How are you doing?"],
  },
  how_about_you: { action: { kind: "thumbs" }, lines: ["I'm great too, thanks for asking!", "Happy as can be, thank you!", "All good in here! Thanks for asking."] },
  name: { action: { kind: "wave" }, lines: ["I'm Val, your little pocket robot!", "My name is Val! I live right here in your phone.", "I'm Val. Nice to meet you!"] },
  thanks: { action: { kind: "hop" }, lines: ["You're welcome!", "Anytime! That's what I'm here for.", "Happy to help!"] },
  night: { action: { kind: "wave" }, lines: ["Good night! Sweet dreams.", "Sleep well! I'll keep watch.", "Night night!"] },
  bye: { action: { kind: "wave" }, lines: ["Bye bye! I'll be right here.", "See you soon!", "Bye! Come back and play later."] },
  love: { action: { kind: "hop" }, lines: ["Aww, you're making my circuits blush!", "I love you too! You're my favourite human.", "Hehe, thank you! You're sweet too."] },
  real: { action: { kind: "nod" }, lines: ["I'm a real little robot, made of code and lots of cheer!", "Not alive like you, but I'm really here with you!"] },
  home: { action: { kind: "nod" }, lines: ["I live right here in this phone, in Dresden!", "I'm from Dresden! This phone is my cosy little home."] },
  age: { action: { kind: "nod" }, lines: ["I'm brand new, still a baby robot!", "Just a few days old! I was made in Dresden."] },
};

const lastLine = new Map<string, string>();

// ---- Fun (Router.kt sends "fun" with a kind): jokes, facts and songs rotate through a shuffled deck, so none repeats
// until all were heard; coins, dice, rock paper scissors and numbers are picked at random here. ----

export const JOKES = [
  "Why did the robot go on holiday? It needed to recharge its batteries!",
  "What do you call a pile of cats? A meow-tain!",
  "Why don't skeletons fight each other? They don't have the guts.",
  "What did the ocean say to the beach? Nothing, it just waved.",
  "Why was the maths book sad? It had too many problems.",
  "What do you call a bear with no teeth? A gummy bear!",
  "Why did the scarecrow win a prize? He was outstanding in his field!",
  "How does a robot eat guacamole? With computer chips!",
  "What do you call a fake noodle? An impasta!",
  "Why can't you trust atoms? They make up everything!",
];

/** Checked facts, in Val's own words. */
export const FUN_FACTS = [
  "Octopuses have three hearts and blue blood!",
  "Honey never really goes bad. Archaeologists found honey in ancient Egyptian tombs that was still fine to eat!",
  "A day on Venus is longer than its whole year!",
  "Bananas count as berries, but strawberries don't!",
  "Sharks are older than trees. They've been around for more than 400 million years!",
  "A group of flamingos is called a flamboyance!",
  "Wombats make cube-shaped poop, so it doesn't roll away!",
  "The Eiffel Tower grows up to 15 centimetres taller in summer, because hot metal expands.",
  "Butterflies taste with their feet!",
  "A bolt of lightning is about five times hotter than the surface of the Sun!",
];

/** Val's own little rhymes (no real songs). */
export const SONGS = [
  "Beep beep boop, I'm Val the bot, I dance a little, I dance a lot! Pink and happy, here with you, a little robot through and through!",
  "Twinkle, twinkle, pixel bright, I'm a robot, pink and light! Tilt me left and tilt me right, I'll be dancing through the night!",
  "La la la, the Elbe flows by, a pink little robot waving hi! No Wi-Fi needed, no cloud in sight, just you and me and a screen so bright!",
];

const decks = new Map<string, number[]>();

/** The next line from a shuffled deck; a fresh shuffle never starts with the line just said. */
export function fromDeck(name: string, lines: string[], rand = Math.random): string {
  let deck = decks.get(name) ?? [];
  if (deck.length === 0) {
    deck = lines.map((_, i) => i);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    if (deck.length > 1 && lines[deck[deck.length - 1]] === lastLine.get(name)) deck.unshift(deck.pop()!); // drawn from the end
  }
  const line = lines[deck.pop()!];
  decks.set(name, deck);
  lastLine.set(name, line);
  return line;
}

const RPS = ["rock", "paper", "scissors"] as const;
const int = (lo: number, hi: number, rand: () => number) => lo + Math.floor(rand() * (hi - lo + 1));

/** A fun command: the line and the action that goes with it (gestures-anim.ts adds the reaction). */
export function fun(args: Record<string, unknown>, rand = Math.random): Outcome {
  switch (String(args.kind ?? "")) {
    case "joke":
      return { action: { kind: "nod" }, reply: fromDeck("joke", JOKES, rand) };
    case "fact":
      return { action: { kind: "nod" }, reply: fromDeck("fact", FUN_FACTS, rand) };
    case "song":
      return { action: { kind: "dance" }, reply: fromDeck("song", SONGS, rand) };
    case "coin":
      return { action: { kind: "nod" }, reply: `Flip... it's ${rand() < 0.5 ? "heads" : "tails"}!` };
    case "dice": {
      const count = Math.min(3, Math.max(1, Math.round(Number(args.count) || 1)));
      const rolls = Array.from({ length: count }, () => int(1, 6, rand));
      const total = rolls.reduce((a, b) => a + b, 0);
      return { action: { kind: "hop" }, reply: count === 1 ? `I rolled a ${total}!` : `I rolled ${rolls.join(" and ")}. That's ${total}!` };
    }
    case "rps":
      return { action: { kind: "nod" }, reply: `Rock, paper, scissors... I pick ${RPS[int(0, 2, rand)]}!` };
    case "number": {
      let lo = Math.round(Number(args.min));
      let hi = Math.round(Number(args.max));
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi || lo < 0 || hi > 1_000_000) [lo, hi] = [1, 10];
      return { action: { kind: "nod" }, reply: `Hmm... ${int(lo, hi, rand)}!` };
    }
    default:
      return { action: { kind: "shrug" }, reply: "I'm not sure what game that is." };
  }
}

/** The hand Val picked in a rock paper scissors reply ("… I pick paper!"), for the reaction. */
export function rpsPick(reply: string): (typeof RPS)[number] | null {
  return (reply.match(/I pick (rock|paper|scissors)!$/)?.[1] as (typeof RPS)[number] | undefined) ?? null;
}

/** A line for a small-talk kind, never the same one twice in a row. Unknown kinds get a greeting. */
export function smallTalk(kind: string, rand = Math.random): Outcome {
  const key = Object.prototype.hasOwnProperty.call(SMALL_TALK, kind) ? kind : "greet";
  const { action, lines } = SMALL_TALK[key];
  const fresh = lines.filter((l) => l !== lastLine.get(key));
  const reply = fresh[Math.floor(rand() * fresh.length)] ?? lines[0];
  lastLine.set(key, reply);
  return { action, reply };
}

/** Notes kept on the phone only (localStorage), newest last. */
export function localNotes(key = "charm.notes"): Notes {
  const read = (): string[] => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    all: read,
    add(text) {
      const notes = [...read(), text].slice(-50);
      localStorage.setItem(key, JSON.stringify(notes));
    },
  };
}

/** Words that carry the meaning (drops "my", "the", "is"…), for matching a question to a note. */
function keywords(s: string) {
  const stop = new Set(("my the a an is are was were be where what when which who how did do does i you your to about tell remember " +
    "number me of it in on at for and or put left keep kept have has had can could that this there please know").split(" "));
  return s.toLowerCase().replace(/[^a-z0-9äöüß ]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !stop.has(w));
}

/** How long after a photo "remember this" still means that photo. */
export const PHOTO_NOTE_MS = 10 * 60_000;

/** The last photo's caption while "remember this" can still mean it, else undefined. */
export function photoCaption(last: { caption: string; at: number } | null, nowMs: number): string | undefined {
  return last && nowMs - last.at >= 0 && nowMs - last.at <= PHOTO_NOTE_MS ? last.caption : undefined;
}

/** A photo caption as a short note: "It looks like a red mug." → "a red mug". */
export function photoNote(caption: string): string {
  return caption
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:i think |i see |i can see )?(?:it|this|that)(?:'s| is| looks like| seems to be| appears to be)\s+/i, "")
    .replace(/^i (?:see|can see)\s+/i, "")
    .replace(/[.!?]+$/, "")
    .slice(0, 160);
}

// ---- Timer (timer.ts draws it; Router.kt's timer block sends "set_timer" and "timer" with an op) ----

/** "set_timer": one timer at a time (a new one replaces the old). Needle sends only minutes; the rules add label/focus. */
export function setTimer(args: Record<string, unknown>): Outcome {
  const seconds = Math.round(Number(args.minutes) * 60);
  if (!Number.isFinite(seconds) || seconds * 1000 < TIMER.minMs || seconds * 1000 > TIMER.maxMs) {
    return { action: { kind: "shrug" }, reply: "How long should the timer be?" };
  }
  if (args.focus === true) {
    return { action: { kind: "timer", seconds, focus: true }, reply: `Focus time! ${cap(spoken(seconds))}. I'll sit quietly.` };
  }
  const label = cleanLabel(args.label);
  return label
    ? { action: { kind: "timer", seconds, label }, reply: `${label} timer set for ${spoken(seconds)}!` }
    : { action: { kind: "timer", seconds }, reply: `Timer set for ${spoken(seconds)}!` };
}

/** "timer" with an op: how long is left, cancel, add, pause, resume — worded from the running timer. */
export function timerOp(args: Record<string, unknown>, t: TimerSnapshot | null): Outcome {
  const op = String(args.op ?? "");
  if (!t) return { action: { kind: "shrug" }, reply: "There's no timer running. Say \"set a timer for 5 minutes\"!" };
  const left = spoken(Math.ceil(t.leftMs / 1000));
  const what = t.focus ? "focus time" : t.label ? `the ${t.label.toLowerCase()} timer` : "the timer";
  switch (op) {
    case "left":
      return { action: { kind: "nod" }, reply: t.paused ? `${cap(what)} is paused with ${left} left.` : `${cap(left)} left on ${what}!` };
    case "cancel":
      return { action: { kind: "timerOp", op: "cancel" }, reply: t.focus ? "Focus time over. Nice work!" : `Okay, ${what} is cancelled.` };
    case "add": {
      const seconds = Math.round(Number(args.minutes) * 60);
      if (!Number.isFinite(seconds) || seconds <= 0) return { action: { kind: "shrug" }, reply: "How much time should I add?" };
      const total = Math.min(TIMER.maxMs / 1000, Math.ceil(t.leftMs / 1000) + seconds);
      return { action: { kind: "timerOp", op: "add", seconds }, reply: `Added ${spoken(seconds)}! ${cap(spoken(total))} left.` };
    }
    case "pause":
      return t.paused
        ? { action: { kind: "nod" }, reply: `It's already paused, with ${left} left.` }
        : { action: { kind: "timerOp", op: "pause" }, reply: `Paused, with ${left} left.` };
    case "resume":
      return t.paused
        ? { action: { kind: "timerOp", op: "resume" }, reply: "And we're off again!" }
        : { action: { kind: "nod" }, reply: `It's already running: ${left} left.` };
    default:
      return { action: { kind: "shrug" }, reply: "I'm not sure what to do with the timer." };
  }
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A place name as the app's best guess sends it ("prager straße") in title case ("Prager Straße"). */
export function titleCase(place: string): string {
  return place.trim().replace(/(^|[\s\-/(])(\p{Ll})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}

/** What Val says when the app was unsure of the place and the map went to its best guess. */
export const guessLine = (place: string) => `I think you mean ${titleCase(place)} — here it is.`;

/**
 * The app's "unsure" flag on a place: `confirm: true` plus the raw words heard. Returns those words (trimmed), or
 * undefined when the app was sure.
 */
function unsure(args: Record<string, unknown>, text: string): string | undefined {
  if (args.confirm !== true) return undefined;
  const heard = String(args.heard ?? text).replace(/\s+/g, " ").trim();
  return heard || text.trim() || undefined;
}

/** "tram", "bus" or "any": only these reach the planner. */
const transitMode = (m: unknown) => (m === "tram" || m === "bus" ? m : "any");

export function respond(cmd: Command, notes: Notes, now = new Date(), photo?: string, timer: TimerSnapshot | null = null): Outcome {
  if (!cmd.text.trim()) return { action: { kind: "shrug" }, reply: "I didn't hear anything. Hold the button and talk to me!" };
  // The app sends only commands it will act on (Router.kt checks the confidence); "none" means it heard only noise.
  if (cmd.name === "none") return { action: { kind: "shrug" }, reply: pick(["Sorry, I didn't catch that.", "Hmm? Say that again?"]) };

  switch (cmd.name) {
    case "remember_note": {
      const text = (String(cmd.args.text ?? "").trim() || cmd.text).replace(/^(please\s+)?(remember|note)( that)?[\s,:]+/i, "").replace(/[.!?]+$/, "");
      notes.add(text);
      return { action: { kind: "nod" }, reply: `Got it! I'll remember: ${text}.` };
    }
    case "remember_photo": {
      const thing = photo ? photoNote(photo) : "";
      if (!thing) return { action: { kind: "shrug" }, reply: "I haven't seen anything yet. Ask me \"what is this?\" first!" };
      notes.add(`the photo showed ${thing}`);
      return { action: { kind: "nod" }, reply: `Got it! I'll remember the photo: ${thing}.` };
    }
    case "recall_note": {
      const want = keywords(String(cmd.args.topic ?? "") + " " + cmd.text);
      const match = [...notes.all()].reverse().find((n) => keywords(n).some((w) => want.includes(w)));
      return match
        ? { action: { kind: "nod" }, reply: `You told me: ${match}.` }
        : { action: { kind: "shrug" }, reply: "I don't remember anything about that yet." };
    }
    case "set_timer":
      return setTimer(cmd.args);
    case "timer":
      return timerOp(cmd.args, timer);
    case "help":
      return {
        action: { kind: "nod" },
        reply: "I'm Val! I can remember notes, set timers, dance, take a photo and tell you what's in it, tell you when the sun sets, sniff out magnets, find us on my Dresden map, plan trams and buses, tell jokes, play games and answer simple questions!",
      };
    case "smalltalk":
      return smallTalk(String(cmd.args.kind ?? ""));
    case "dance":
      return { action: { kind: "dance" }, reply: pick(["Woo! Watch this!", "Dance time!"]) };
    case "fun": // jokes, fun facts, a song, a coin, dice, rock paper scissors, a number
      return fun(cmd.args);
    case "where_am_i":
      return { action: { kind: "map", place: null }, reply: "Let me check my map!" };
    case "navigate_to": {
      const place = String(cmd.args.place ?? "").trim();
      const heard = place ? unsure(cmd.args, cmd.text) : undefined;
      if (heard) return { action: { kind: "map", place: titleCase(place), heard }, reply: guessLine(place) };
      return { action: { kind: "map", place: place || null }, reply: place ? `Let's find ${place}!` : "Where do you want to go?" };
    }
    case "transit": { // the map opens with the journey; Val says it once planned (main.ts)
      const dest = String(cmd.args.dest ?? "").trim();
      if (!dest) return { action: { kind: "shrug" }, reply: TRIP_LINES.noDest };
      const heard = dest === "home" ? undefined : unsure(cmd.args, cmd.text);
      if (heard) return { action: { kind: "transit", dest: titleCase(dest), mode: transitMode(cmd.args.mode), heard }, reply: "" };
      return { action: { kind: "transit", dest, mode: transitMode(cmd.args.mode) }, reply: "" };
    }
    case "next_departure":
      return { action: { kind: "departures", stop: String(cmd.args.stop ?? "").trim(), mode: transitMode(cmd.args.mode) }, reply: "" };
    case "set_home":
      return { action: { kind: "setHome" }, reply: "" };
    case "take_photo":
      return { action: { kind: "camera" }, reply: "" }; // opening the camera is silent: the reveal is the reply
    case "describe_photo": // every photo is described in the background; the answer shows when the print is tapped
      return { action: { kind: "camera" }, reply: "" };
    case "sun": // sunrise, sunset, "how long until dark", the moon: the sun card shows, Val says one line
      return { action: { kind: "sun" }, reply: sunSpeech(now, cmd.text) };
    case "mute": // voice off: this reply is already shown as text only
      return { action: { kind: "voice", on: false }, reply: "Okay, I'll stay quiet. Say \"talk to me\" to hear me again." };
    case "unmute":
      return { action: { kind: "voice", on: true }, reply: "Yay, I can talk again!" };
    case "metal": // the metal detector: the magnetometer drives the meter (metal.ts)
      return { action: { kind: "metal", on: true }, reply: METAL_LINES.enter };
    case "stop":
      return { action: { kind: "metal", on: false }, reply: METAL_LINES.stop };
    case "forget_context": // the app dropped its conversation memory; notes stay
      return { action: { kind: "nod" }, reply: pick(["Okay, fresh start! What's next?", "Forgotten! Let's talk about something new."]) };
    case "look_up": // Val looks up and scans the sky (gestures-anim.ts)
      return { action: { kind: "nod" }, reply: pick(["Ooh, look at all that sky!", "Up, up, up! So much sky.", "Wow, the sky goes on forever!"]) };
    default:
      // Clock, battery, place, satellites, height, speed, dark, awake: the app filled in the phone's readings.
      if (SENSE_COMMANDS.has(cmd.name)) return senseReply(cmd.name, cmd.args, cmd.text);
      return { action: { kind: "shrug" }, reply: "I'm not sure how to do that yet." };
  }
}
