import { test } from "node:test";
import assert from "node:assert/strict";
import {
  caption,
  closesWhenHidden,
  describeMessage,
  DEVELOP_MS,
  errorCaption,
  frameSize,
  polaroidTap,
  PULSE_MS,
  PULSE_OPACITY,
  readAnswer,
  timelineLine,
  transition,
  VIEWFINDER_FADE_MS,
  type CameraEvent,
  type CameraState,
} from "../src/camera/logic";

test("frames shrink to 512 px on the long side and keep their aspect", () => {
  assert.deepEqual(frameSize(640, 480), { w: 512, h: 384 });
  assert.deepEqual(frameSize(480, 640), { w: 384, h: 512 });
  assert.deepEqual(frameSize(1920, 1080), { w: 512, h: 288 });
});
test("small frames are not blown up, and empty ones give null", () => {
  assert.deepEqual(frameSize(320, 240), { w: 320, h: 240 });
  assert.equal(frameSize(0, 480), null);
  assert.equal(frameSize(NaN, 480), null);
});

test("the describe message carries plain base64 and a capped prompt", () => {
  const m = describeMessage(7, "data:image/jpeg;base64,QUJD", "x".repeat(300));
  assert.equal(m.type, "describe");
  assert.equal(m.id, 7);
  assert.equal(m.image, "QUJD");
  assert.equal(m.prompt.length, 200);
  assert.match(describeMessage(1, "data:image/jpeg;base64,QUJD").prompt, /It looks like/);
});

test("answers for an older photo are ignored", () => {
  assert.equal(readAnswer({ type: "vision", id: 1, text: "It looks like a mug", ms: 9000 }, 2), null);
  assert.deepEqual(readAnswer({ type: "vision", id: 2, text: "It looks like a mug", ms: 9000 }, 2), { ok: true, text: "It looks like a mug.", ms: 9000 });
});
test("errors and empty answers become failures; other messages are not answers", () => {
  assert.deepEqual(readAnswer({ type: "visionError", id: 3, reason: "busy" }, 3), { ok: false, reason: "busy" });
  assert.equal(readAnswer({ type: "vision", id: 3, text: "  " }, 3)?.ok, false);
  assert.equal(readAnswer({ type: "heard", id: 3 }, 3), null);
});

test("captions are one tidy line", () => {
  assert.equal(caption("  It looks like\n a mug  "), "It looks like a mug.");
  assert.equal(caption("Is it a cat?"), "Is it a cat?");
  const long = caption("It looks like " + "a very long sentence ".repeat(20));
  assert.ok(long.length <= 140 && long.endsWith("…"));
  assert.match(errorCaption("vision model missing (run scripts/prepare-phone.sh)"), /installed/);
  assert.match(errorCaption("vision server crashed"), /couldn't/);
});

test("the state machine walks open → preview → capturing → developing → done", () => {
  let s: CameraState = "closed";
  const run = (...es: CameraEvent[]) => es.forEach((e) => (s = transition(s, e)));
  run("open");
  assert.equal(s, "opening");
  run("shutter"); // too early: ignored
  assert.equal(s, "opening");
  run("ready", "shutter", "sent");
  assert.equal(s, "developing");
  run("answer");
  assert.equal(s, "done");
  run("close");
  assert.equal(s, "closed");
});
test("failures and closing", () => {
  assert.equal(transition("opening", "fail"), "error");
  assert.equal(transition("capturing", "fail"), "error");
  assert.equal(transition("developing", "close"), "closed");
  assert.equal(transition("error", "open"), "opening");
  assert.equal(transition("closed", "answer"), "closed"); // a late answer after closing changes nothing
});

test("the permission dialog (page hidden while opening) does not close the camera; backgrounding later does", () => {
  // First open: open → (Android's permission dialog pauses the app: hidden) → the stream arrives → preview.
  let s: CameraState = transition("closed", "open");
  assert.equal(closesWhenHidden(s), false);
  s = transition(s, "ready");
  assert.equal(s, "preview");
  // Leaving the app with the viewfinder, a photo developing, or an answer up lets the camera go.
  for (const st of ["preview", "capturing", "developing", "done", "error"] as CameraState[]) assert.equal(closesWhenHidden(st), true, st);
  assert.equal(closesWhenHidden("closed"), false);
});

test("tapping the Polaroid reveals a ready answer, says hmm while waiting, and does nothing twice", () => {
  assert.equal(polaroidTap("done", false), "reveal");
  assert.equal(polaroidTap("developing", false), "hmm");
  assert.equal(polaroidTap("done", true), "none");
  assert.equal(polaroidTap("capturing", false), "none");
  assert.equal(polaroidTap("preview", false), "none");
});

test("a retake from the Polaroid goes back to the viewfinder; a late answer after closing changes nothing", () => {
  assert.equal(transition("developing", "open"), "opening");
  assert.equal(transition("done", "open"), "opening");
  assert.equal(transition("closed", "answer"), "closed");
  assert.equal(transition("capturing", "answer"), "capturing"); // the request is only sent once the photo is encoded
});

test("the open timeline prints every mark relative to the start", () => {
  const line = timelineLine(1000, { gum: 1400, play: 1450, firstFrame: 1600, beat: 2300, shown: 2316, faded: 2500 }, "rvfc");
  assert.equal(line, "camera timeline: gum=400 play=450 firstFrame=600(rvfc) beat=1300 visible=1316 faded=1500 beatToVisible=16");
  assert.match(timelineLine(0, { beat: 10 }), /gum=- .*visible=-/);
});

test("the develop is a short cosmetic beat and the viewfinder fade is quick", () => {
  assert.ok(DEVELOP_MS <= 800);
  assert.ok(VIEWFINDER_FADE_MS <= 200);
});

test("the shutter never whites out the screen: a short, soft edge glow", () => {
  assert.ok(PULSE_MS <= 80);
  assert.ok(PULSE_OPACITY <= 0.35);
});
