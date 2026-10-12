import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fallbackReply,
  guessLine,
  FUN_FACTS,
  fun,
  JOKES,
  rpsPick,
  SONGS,
  ANSWER_MARGIN_MS,
  answerReply,
  answerWait,
  DEFAULT_ANSWER_MS,
  PHOTO_NOTE_MS,
  photoCaption,
  photoNote,
  respond,
  SMALL_TALK,
  smallTalk,
  WARMING_TIMEOUT_MS,
  type Command,
  type Notes,
} from "../src/assistant";

const memory = (): Notes => {
  const xs: string[] = [];
  return { all: () => xs, add: (t) => xs.push(t) };
};
const cmd = (name: string, args: Record<string, unknown> = {}, text = "something", confidence = 0.5): Command => ({ name, args, text, confidence });

test("remember this saves the last photo as a note that recall finds", () => {
  const n = memory();
  const r = respond(cmd("remember_photo", {}, "remember this"), n, new Date(), "It looks like a red mug on a table.");
  assert.equal(r.action.kind, "nod");
  assert.match(r.reply, /red mug on a table/);
  assert.deepEqual(n.all(), ["the photo showed a red mug on a table"]);
  assert.match(respond(cmd("recall_note", { topic: "the photo" }, "do you remember the photo"), n).reply, /red mug/);
});

test("remember this with no recent photo saves nothing", () => {
  const n = memory();
  assert.equal(respond(cmd("remember_photo", {}, "remember this"), n).action.kind, "shrug");
  assert.equal(n.all().length, 0);
});

test("photo captions turn into short notes and expire", () => {
  assert.equal(photoNote("It looks like a banana."), "a banana");
  assert.equal(photoNote("I see a bicycle!"), "a bicycle");
  assert.equal(photoNote("A cat on a sofa"), "A cat on a sofa");
  const last = { caption: "It looks like a mug.", at: 1000 };
  assert.equal(photoCaption(last, 1000 + PHOTO_NOTE_MS), "It looks like a mug.");
  assert.equal(photoCaption(last, 1001 + PHOTO_NOTE_MS), undefined);
  assert.equal(photoCaption(null, 0), undefined);
});

test("remember then recall the locker", () => {
  const n = memory();
  assert.match(respond(cmd("remember_note", { text: "my locker is 42" }), n).reply, /locker is 42/);
  const r = respond(cmd("recall_note", { topic: "locker" }, "where is my locker"), n);
  assert.match(r.reply, /locker is 42/);
});
test("mute and unmute switch the voice", () => {
  assert.deepEqual(respond(cmd("mute", {}, "be quiet"), memory()).action, { kind: "voice", on: false });
  assert.deepEqual(respond(cmd("unmute", {}, "talk to me"), memory()).action, { kind: "voice", on: true });
});

test("recall with nothing stored says so honestly", () =>
  assert.match(respond(cmd("recall_note", { topic: "car" }), memory()).reply, /don't remember/));
test("a timer with a silly length asks again", () => {
  assert.equal(respond(cmd("set_timer", { minutes: 0 }), memory()).action.kind, "shrug");
  assert.deepEqual(respond(cmd("set_timer", { minutes: 5 }), memory()).action, { kind: "timer", seconds: 300 });
});

test("timers are set in seconds, with a label or as focus time", () => {
  const r = respond(cmd("set_timer", { minutes: 1.5 }), memory());
  assert.deepEqual(r.action, { kind: "timer", seconds: 90 });
  assert.equal(r.reply, "Timer set for a minute and a half!");
  assert.equal(respond(cmd("set_timer", { minutes: 0.5 }), memory()).reply, "Timer set for 30 seconds!");
  const pasta = respond(cmd("set_timer", { minutes: 8, label: "pasta" }), memory());
  assert.deepEqual(pasta.action, { kind: "timer", seconds: 480, label: "Pasta" });
  assert.equal(pasta.reply, "Pasta timer set for 8 minutes!");
  const focus = respond(cmd("set_timer", { minutes: 25, focus: true }), memory());
  assert.deepEqual(focus.action, { kind: "timer", seconds: 1500, focus: true });
  assert.match(focus.reply, /^Focus time! 25 minutes/);
  assert.equal(respond(cmd("set_timer", { minutes: 600 }), memory()).action.kind, "shrug"); // over 3 hours
});

test("timer controls are worded from the running timer", () => {
  const running = { leftMs: 272_000, totalMs: 300_000, paused: false };
  const ask = (args: Record<string, unknown>, t: typeof running | null = running) => respond(cmd("timer", args), memory(), new Date(), undefined, t);
  assert.equal(ask({ op: "left" }).reply, "4 minutes 32 seconds left on the timer!");
  assert.equal(ask({ op: "left" }, { ...running, label: "Pasta" } as typeof running).reply, "4 minutes 32 seconds left on the pasta timer!");
  assert.equal(ask({ op: "left" }, null).action.kind, "shrug");
  assert.deepEqual(ask({ op: "cancel" }).action, { kind: "timerOp", op: "cancel" });
  assert.deepEqual(ask({ op: "add", minutes: 1 }).action, { kind: "timerOp", op: "add", seconds: 60 });
  assert.equal(ask({ op: "add", minutes: 1 }).reply, "Added 1 minute! 5 minutes 32 seconds left.");
  assert.deepEqual(ask({ op: "pause" }).action, { kind: "timerOp", op: "pause" });
  assert.equal(ask({ op: "pause" }, { ...running, paused: true }).action.kind, "nod");
  assert.deepEqual(ask({ op: "resume" }, { ...running, paused: true }).action, { kind: "timerOp", op: "resume" });
  assert.equal(ask({ op: "resume" }).action.kind, "nod");
  assert.equal(ask({ op: "cancel" }, null).action.kind, "shrug");
});
test("nothing heard, or nothing picked, never triggers an action", () => {
  assert.equal(respond(cmd("dance", {}, "  "), memory()).action.kind, "shrug");
  assert.equal(respond(cmd("none"), memory()).action.kind, "shrug");
});
test("questions are never answered with a canned 'can't look that up'", () =>
  assert.doesNotMatch(respond(cmd("answer_question", { question: "how old is the Zwinger" }), memory()).reply, /look that up/));
test("a chat answer is spoken as it came, trimmed and capped", () => {
  assert.deepEqual(answerReply({ ok: true, reply: "  The Zwinger is a baroque palace.\n" }), { ok: true, reply: "The Zwinger is a baroque palace." });
  assert.equal(answerReply({ ok: true, reply: "x".repeat(900) }).reply.length, 300);
});
test("a failed or empty answer gets a friendly line, never the raw reason", () => {
  for (const reason of ["busy", "model missing (run scripts/prepare-phone.sh)", "timeout", "server crashed", ""]) {
    const out = answerReply({ ok: false, reason });
    assert.equal(out.ok, false);
    assert.doesNotMatch(out.reply, /prepare-phone|crashed|timeout/);
    assert.ok(out.reply.length > 10);
  }
  assert.equal(answerReply({ ok: true, reply: "   " }).ok, false);
  assert.equal(answerReply({ ok: true, reply: 42 }).ok, false);
});
test("the page waits the app's limit plus a margin, and longer while warming", () => {
  assert.equal(answerWait({}), DEFAULT_ANSWER_MS + ANSWER_MARGIN_MS);
  assert.equal(answerWait({}), 8000);
  assert.equal(answerWait({ warming: false, ms: 12_000 }), 12_000 + ANSWER_MARGIN_MS);
  assert.equal(answerWait({ warming: true, ms: 6500 }), WARMING_TIMEOUT_MS);
  assert.equal(answerWait({ ms: "junk" }), DEFAULT_ANSWER_MS + ANSWER_MARGIN_MS);
  assert.equal(answerWait({ ms: 1e9 }), DEFAULT_ANSWER_MS + ANSWER_MARGIN_MS);
});
test("photo and map commands map to their actions", () => {
  assert.deepEqual(respond(cmd("describe_photo"), memory()).action, { kind: "camera" });
  // Opening the camera is silent: no spoken or shown line, just the reveal.
  assert.equal(respond(cmd("describe_photo"), memory()).reply, "");
  assert.equal(respond(cmd("take_photo"), memory()).reply, "");
  assert.deepEqual(respond(cmd("navigate_to", { place: "Frauenkirche" }), memory()).action, { kind: "map", place: "Frauenkirche" });
});
test("an unsure place still opens the map on the best guess, and Val says it is a guess", () => {
  const out = respond(cmd("navigate_to", { place: "hauptbahnhof", confirm: true, heard: " how about the main  bahn hof " }, "how about the main bahn hof"), memory());
  assert.deepEqual(out.action, { kind: "map", place: "Hauptbahnhof", heard: "how about the main bahn hof" });
  assert.equal(out.reply, "I think you mean Hauptbahnhof — here it is.");
  // No heard words from the app: the transcript stands in.
  assert.equal((respond(cmd("navigate_to", { place: "prager straße", confirm: true }, "prager strasse"), memory()).action as { heard?: string }).heard, "prager strasse");
  assert.equal(guessLine("prager straße"), "I think you mean Prager Straße — here it is.");
  // Sure (no flag, or anything but true): as before.
  assert.deepEqual(respond(cmd("navigate_to", { place: "Zwinger", confirm: "yes" }), memory()).action, { kind: "map", place: "Zwinger" });
  assert.equal(respond(cmd("navigate_to", { place: "Zwinger" }), memory()).reply, "Let's find Zwinger!");
  // Trams and buses: the same flag rides on the trip; home is never a guess.
  assert.deepEqual(respond(cmd("transit", { dest: "zwinger", mode: "tram", confirm: true, heard: "zwinga" }, "tram to zwinga"), memory()).action,
    { kind: "transit", dest: "Zwinger", mode: "tram", heard: "zwinga" });
  assert.deepEqual(respond(cmd("transit", { dest: "home", confirm: true, heard: "hum" }, "bus hum"), memory()).action, { kind: "transit", dest: "home", mode: "any" });
  assert.deepEqual(respond(cmd("transit", { dest: "Zwinger" }), memory()).action, { kind: "transit", dest: "Zwinger", mode: "any" });
});
test("a sun question shows the sun card and says a short line, no emoji", () => {
  const evening = new Date("2026-10-10T17:40:00+02:00"); // sunset in Dresden ~18:25
  const out = respond(cmd("sun", {}, "when is sunset"), memory(), evening);
  assert.deepEqual(out.action, { kind: "sun" });
  assert.match(out.reply, /^Sunset is in 4\d minutes, at \d\d:\d\d\. Golden hour, quick!$/);
  const night = respond(cmd("sun", {}, "how long until dark"), memory(), new Date("2026-10-10T22:00:00+02:00"));
  assert.match(night.reply, /^The sun set at \d\d:\d\d\. It's back in 9 hours and \d+ minutes?, at \d\d:\d\d!$/);
  const moon = respond(cmd("sun", {}, "what's the moon phase"), memory(), evening);
  assert.match(moon.reply, /^It's a [a-z ]+ moon, \d{1,3} percent lit\. (Pretty|Good night for stars)!$/);
  for (const r of [out.reply, night.reply, moon.reply]) assert.doesNotMatch(r, /\p{Extended_Pictographic}/u);
});
test("an unknown command name is handled, not crashed on", () =>
  assert.equal(respond(cmd("launch_rocket"), memory()).action.kind, "shrug"));
test("a fallback note drops the leading 'remember'", () =>
  assert.equal(respond(cmd("remember_note", {}, "Remember my locker is 42."), memory()).reply, "Got it! I'll remember: my locker is 42."));
test("filler words never match the wrong note", () => {
  const n = memory();
  n.add("I put the bag on the chair");
  assert.match(respond(cmd("recall_note", {}, "where did I put my keys"), n).reply, /don't remember/);
});
test("a busy model says which job keeps it busy", () => {
  assert.match(fallbackReply("busy question"), /last question/);
  assert.match(fallbackReply("busy photo"), /photo/);
});

test("jokes and fun facts rotate: none repeats until all were heard, and never twice in a row", () => {
  for (const [kind, lines] of [["joke", JOKES], ["fact", FUN_FACTS]] as const) {
    assert.ok(lines.length >= 8);
    const heard: string[] = [];
    for (let i = 0; i < lines.length * 3; i++) heard.push(respond(cmd("fun", { kind }, "tell me"), memory()).reply);
    for (let round = 0; round < 3; round++) {
      assert.equal(new Set(heard.slice(round * lines.length, (round + 1) * lines.length)).size, lines.length, `${kind} round ${round}`);
    }
    for (let i = 1; i < heard.length; i++) assert.notEqual(heard[i], heard[i - 1], `${kind} twice in a row at ${i}`);
    for (const l of lines) assert.ok(l.split(/\s+/).length <= 30, l);
  }
});

test("a song is one of Val's own rhymes, with a dance", () => {
  const out = fun({ kind: "song" });
  assert.equal(out.action.kind, "dance");
  assert.ok(SONGS.includes(out.reply));
});

test("coins, dice, rock paper scissors and numbers are random and in range", () => {
  assert.equal(fun({ kind: "coin" }, () => 0.1).reply, "Flip... it's heads!");
  assert.equal(fun({ kind: "coin" }, () => 0.9).reply, "Flip... it's tails!");
  assert.equal(fun({ kind: "dice" }, () => 0).reply, "I rolled a 1!");
  assert.equal(fun({ kind: "dice" }, () => 0.999).reply, "I rolled a 6!");
  assert.equal(fun({ kind: "dice" }, () => 0).action.kind, "hop");
  assert.equal(fun({ kind: "dice", count: 2 }, () => 0.5).reply, "I rolled 4 and 4. That's 8!");
  assert.equal(fun({ kind: "rps" }, () => 0.5).reply, "Rock, paper, scissors... I pick paper!");
  assert.equal(rpsPick(fun({ kind: "rps" }, () => 0).reply), "rock");
  assert.equal(rpsPick(fun({ kind: "rps" }, () => 0.99).reply), "scissors");
  for (let i = 0; i < 200; i++) {
    const n = Number(/(\d+)/.exec(fun({ kind: "number", min: 5, max: 7 }).reply)?.[1]);
    assert.ok(n >= 5 && n <= 7, String(n));
  }
  assert.equal(fun({ kind: "number", min: 9, max: 3 }, () => 0).reply, "Hmm... 1!"); // nonsense range → 1 to 10
  assert.equal(fun({ kind: "number" }, () => 0.999).reply, "Hmm... 10!");
  assert.equal(fun({ kind: "nope" }).action.kind, "shrug");
});

test("forget_context: Val starts a new topic and keeps the notes", () => {
  const n = memory();
  n.add("my locker is 42");
  const r = respond(cmd("forget_context", {}, "forget that"), n);
  assert.equal(r.action.kind, "nod");
  assert.match(r.reply, /fresh start|new/i);
  assert.deepEqual(n.all(), ["my locker is 42"]);
});
