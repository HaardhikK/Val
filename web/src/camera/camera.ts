// "Take a photo / what is this?": a retro viewfinder over the live rear camera, a shutter, and a Polaroid. The
// vision model starts on the photo the moment it is taken; its answer shows (and is spoken) when you tap the print.
// Photos live only in memory and are dropped on close.
import type { Bridge, NativeEvent, VisionEvent } from "../bridge";
import {
  ANSWER_TIMEOUT_MS,
  closesWhenHidden,
  describeMessage,
  FIRST_FRAME_GRACE_MS,
  JPEG_QUALITY,
  errorCaption,
  frameSize,
  polaroidTap,
  PULSE_MS,
  PULSE_OPACITY,
  readAnswer,
  timelineLine,
  transition,
  type CameraEvent,
  type CameraState,
  type TimelineMark,
  type VisionAnswer,
} from "./logic";
import { injectCameraStyle } from "./style";

/** What the rest of the page does around the camera (shrinking Val into a corner bubble, his flash, …). */
export interface CameraHooks {
  /** The viewfinder starts to show (fade-in): shrink Val into the corner bubble in the same frame. */
  onShow?: () => void;
  /** The camera closed (by itself, a swipe, or close()). */
  onHide?: () => void;
  /** A photo is taken: Val's camera flashes in the bubble, in sync with the edge glow and the click. */
  onShutter?: () => void;
  /** Tapped before the answer is in: Val looks at the photo (true) until it shows (false). */
  onPeek?: (on: boolean) => void;
  /** The answer is revealed (the user tapped the print): speak it. */
  onAnswer?: (text: string) => void;
  log?: (msg: string) => void;
}

export interface Camera {
  /**
   * Start the camera now, and show the viewfinder once `beat` (Val's reveal) has finished AND the first real frame
   * exists. From the Polaroid, open() again is a retake (no beat).
   */
  open(beat?: Promise<unknown>): void;
  /** Take the photo (tap, the volume "look" shortcut, or "take a photo"). */
  shutter(): void;
  close(): void;
  /** Make the shutter's audio (context and noise) once, in idle time after start-up; open() only resumes it. */
  warm(): void;
  readonly state: CameraState;
}

const SWIPE_CLOSE_PX = 70;
/** A camera that finished opening while the app was in the background is let go if the app stays away this long. */
const HIDDEN_OPEN_GRACE_MS = 3000;

export function createCamera(root: HTMLElement, bridge: Pick<Bridge, "send" | "onVision">, hooks: CameraHooks = {}): Camera {
  injectCameraStyle();
  // Built once at start-up (hidden), grain included, so opening never creates DOM or canvases.
  const el = document.createElement("div");
  el.id = "cam";
  el.innerHTML = `
    <video playsinline muted></video>
    <div class="vf">
      <div class="grain"></div><div class="vignette"></div>
      <div class="corner tl"></div><div class="corner tr"></div><div class="corner bl"></div><div class="corner br"></div>
      <div class="rec"><i></i>REC</div>
      <div class="hint">Tap to shoot</div>
      <div class="meta">ISO 400 · f/2.8 · 1/60</div>
    </div>
    <div class="msg"></div>
    <div class="polaroid"><div class="photo"><img class="dev" alt=""><img class="raw" alt=""></div><div class="strip"></div></div>
    <div class="pulse"></div>`;
  root.appendChild(el);
  const $ = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
  const video = $<HTMLVideoElement>("video");
  const msg = $<HTMLDivElement>(".msg");
  const polaroid = $<HTMLDivElement>(".polaroid");
  const dev = $<HTMLImageElement>("img.dev");
  const raw = $<HTMLImageElement>("img.raw");
  const strip = $<HTMLDivElement>(".strip");
  const pulseEl = $<HTMLDivElement>(".pulse");
  $<HTMLDivElement>(".grain").style.backgroundImage = `url(${grainTexture()})`;
  const shot = document.createElement("canvas"); // the photo's frame grab (sized per shot, emptied after)

  let state: CameraState = "closed";
  let stream: MediaStream | null = null;
  let requestId = 0; // bumped on every photo and on close, so a late answer for an old photo is ignored
  let session = 0; // bumped on every open/close, so a slow camera start after a close is dropped
  let photoUrl = ""; // blob: URL shown on the Polaroid (revoked on reset)
  let answer: VisionAnswer | null = null; // in hand, not necessarily shown
  let revealed = false; // the answer (or "hmm…") is showing: the user tapped the print
  let answerTimer: number | undefined;
  let cameraStarting: Promise<void> | null = null; // a getUserMedia call still in flight
  // The open timeline (debug log for the phone).
  let t0 = 0;
  let marks: Partial<Record<TimelineMark, number>> = {};
  let frameHow = "";
  const log = (m: string) => hooks.log?.(`camera ${m}`);
  const mark = (k: TimelineMark, mine: number) => {
    if (mine === session && marks[k] === undefined) marks[k] = performance.now();
  };

  const go = (e: CameraEvent) => {
    const next = transition(state, e);
    if (next !== state) log(`${state} → ${next}`);
    state = next;
    return state;
  };
  const send = (ev: NativeEvent) => bridge.send(ev);

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    el.classList.remove("live");
  }

  /** A soft cream glow on the viewfinder's edges (opacity only, on the compositor; no layout). */
  function pulse() {
    pulseEl.animate([{ opacity: PULSE_OPACITY }, { opacity: 0 }], { duration: PULSE_MS, easing: "ease-out" });
  }

  /** A retro notice in the viewfinder: a small closed-eye icon, a title tag and one friendly line. */
  function showMsg(title: string, body: string) {
    msg.textContent = "";
    const box = document.createElement("div");
    box.className = "note";
    const ico = document.createElement("span");
    ico.className = "ico";
    ico.setAttribute("aria-hidden", "true");
    ico.textContent = "◡ ◡";
    const tag = document.createElement("b");
    tag.textContent = title;
    const line = document.createElement("span");
    line.textContent = body;
    box.append(ico, tag, line);
    msg.appendChild(box);
  }

  function setStrip(text: string, kind: "" | "tap" | "hmm" = "") {
    strip.textContent = text;
    strip.className = kind ? `strip ${kind}` : "strip";
  }

  /** Resolves when the video has a real decoded frame (requestVideoFrameCallback where it exists, Chrome 83+). */
  function firstFrame(mine: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (how: string) => {
        if (done) return;
        done = true;
        if (mine === session) frameHow = how;
        resolve();
      };
      const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
      if (typeof v.requestVideoFrameCallback === "function") v.requestVideoFrameCallback(() => finish("rvfc"));
      // Fallback (and a race, in case an invisible video gets no frame callbacks): data plus one painted frame.
      const onData = () => {
        if (video.readyState >= 2 && video.videoWidth > 0) requestAnimationFrame(() => finish("data"));
      };
      video.addEventListener("loadeddata", onData, { once: true });
      video.addEventListener("playing", onData, { once: true });
      if (video.readyState >= 2) onData();
    });
  }

  /** Ask for the stream; resolves with it, or null and the failure's name. */
  async function startStream(mine: number): Promise<{ s: MediaStream | null; failure: string }> {
    // A camera start from an earlier open (closed before it finished) must finish and let go first: two starts at
    // once fail on this phone.
    if (cameraStarting) await cameraStarting;
    if (mine !== session) return { s: null, failure: "closed" };
    let failure = "";
    const starting = navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      })
      .then(
        (st): MediaStream | null => {
          if (mine === session) return st;
          st.getTracks().forEach((t) => t.stop()); // closed while the camera was starting: release it at once
          return null;
        },
        (err): null => {
          failure = String((err as Error)?.name ?? err);
          return null;
        },
      );
    const done = starting.then(() => undefined);
    cameraStarting = done;
    const s = await starting;
    if (cameraStarting === done) cameraStarting = null;
    return { s, failure: s ? "" : failure || "closed" };
  }

  async function open(beat?: Promise<unknown>) {
    if (state !== "closed" && state !== "done" && state !== "developing" && state !== "error") return;
    const retake = state !== "closed";
    go("open");
    const mine = ++session;
    t0 = performance.now();
    marks = {};
    frameHow = "";
    resumeClick(); // the shutter's audio (made in idle time at start-up) is running before the first photo
    if (!retake) {
      msg.textContent = "";
      el.classList.add("on"); // laid out now, invisible and untouchable, while Val reveals
    }
    const beatDone = Promise.resolve(beat).then(() => mark("beat", mine));
    // The camera starts at once, in parallel with Val's reveal; the stream plays (hidden) as soon as it arrives.
    const started = startStream(mine).then(({ s, failure }) => {
      mark("gum", mine);
      if (!s) return { ok: false, failure };
      if (mine !== session) {
        s.getTracks().forEach((t) => t.stop());
        return { ok: false, failure: "closed" };
      }
      stream = s;
      video.srcObject = s;
      video.play().then(() => mark("play", mine), () => undefined);
      return { ok: true, failure: "" };
    });
    const framed = started.then((r) => (r.ok ? firstFrame(mine).then(() => mark("firstFrame", mine)) : undefined));
    // Show when both the reveal and the first frame are done; a stuck camera shows anyway after a grace.
    await Promise.all([beatDone, Promise.race([framed, beatDone.then(() => wait(FIRST_FRAME_GRACE_MS))])]);
    const { ok, failure } = await started;
    if (mine !== session) return; // closed meanwhile (startStream released the stream)
    if (retake) resetPhoto();
    if (!ok) {
      showViewfinder(mine, false);
      log(`getUserMedia failed: ${failure}`);
      go("fail");
      if (failure === "NotAllowedError") showMsg("Camera is off", "I need your OK to see. Allow the camera for Charm in Settings, then ask me again.");
      else showMsg("Eyes won't open", "My camera is busy right now. Try again in a moment?");
      setTimeout(() => mine === session && close(), failure === "NotAllowedError" ? 4000 : 2500);
      return;
    }
    if (marks.firstFrame === undefined) log(`first frame late: shown after ${FIRST_FRAME_GRACE_MS} ms grace`);
    showViewfinder(mine, true);
    go("ready");
    if (document.hidden) {
      // Opened while the app was away (not just the permission dialog): let go if it does not come back soon.
      setTimeout(() => mine === session && document.hidden && close(), HIDDEN_OPEN_GRACE_MS);
    }
  }

  /** One frame: the viewfinder fades in (opacity only) while Val shrinks into the bubble. */
  function showViewfinder(mine: number, live: boolean) {
    const first = !el.classList.contains("shown");
    el.classList.toggle("live", live);
    el.classList.add("shown");
    mark("shown", mine);
    if (!first) return void log(timelineLine(t0, marks, frameHow));
    hooks.onShow?.();
    const end = (e: TransitionEvent) => {
      if (e.target !== el) return;
      el.removeEventListener("transitionend", end);
      mark("faded", mine);
      if (mine === session) log(timelineLine(t0, marks, frameHow));
    };
    el.addEventListener("transitionend", end);
  }

  function shutter() {
    if (state !== "preview") return;
    const size = frameSize(video.videoWidth, video.videoHeight);
    if (!size) return; // the first frame has not arrived yet
    go("shutter");
    click();
    pulse();
    hooks.onShutter?.();
    send({ type: "haptic", pattern: "shutter" });
    const canvas = shot; // made once at start-up
    canvas.width = size.w;
    canvas.height = size.h;
    canvas.getContext("2d")!.drawImage(video, 0, 0, size.w, size.h);
    stopStream(); // the viewfinder is done: release the camera while the Polaroid shows
    const mine = session;
    const fail = () => {
      if (mine !== session) return;
      log("photo encode failed");
      go("fail");
      polaroid.className = "polaroid";
      msg.textContent = "Oops, the photo didn't come out. Try again?";
      setTimeout(() => mine === session && close(), 2500);
    };
    // Encoded off the main thread (toBlob), unlike toDataURL which blocks a frame or two on this phone.
    canvas.toBlob(
      (blob) => {
        canvas.width = canvas.height = 0; // free its pixels now
        if (mine !== session) return; // closed meanwhile
        if (!blob) return fail();
        const reader = new FileReader();
        reader.onerror = fail;
        reader.onload = () => {
          if (mine !== session) return;
          ask(String(reader.result ?? "")); // the model starts now, while the print slides up
          photoUrl = URL.createObjectURL(blob);
          dev.src = raw.src = photoUrl;
          raw.className = "raw developing"; // a 600 ms cosmetic develop during the slide-up
          setStrip("Tap to reveal", "tap");
          polaroid.className = "polaroid";
          void polaroid.offsetWidth;
          polaroid.classList.add("up");
        };
        reader.readAsDataURL(blob);
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  }

  /** Send the photo to the app's vision model in the background; the answer waits until the print is tapped. */
  function ask(photoData: string) {
    const id = ++requestId;
    answer = null;
    revealed = false;
    send(describeMessage(id, photoData));
    go("sent");
    clearTimeout(answerTimer);
    answerTimer = window.setTimeout(() => {
      if (id === requestId && state === "developing") arrived({ ok: false, reason: "page timeout" });
    }, ANSWER_TIMEOUT_MS);
  }

  /** The answer (or error) arrived: keep it, and show it at once if the print was already tapped. */
  function arrived(a: VisionAnswer) {
    clearTimeout(answerTimer);
    answer = a;
    go("answer");
    log(a.ok ? `answer in ${a.ms} ms (${revealed ? "tapped: showing" : "kept until tapped"})` : `error ${a.reason}`);
    if (revealed) show();
  }

  /** Put the answer on the strip and speak it (errors are only shown). */
  function show() {
    hooks.onPeek?.(false);
    if (!answer) return;
    if (answer.ok) {
      setStrip(answer.text);
      hooks.onAnswer?.(answer.text);
    } else setStrip(errorCaption(answer.reason));
  }

  function tapPrint() {
    const t = polaroidTap(state, revealed);
    if (t === "none") return;
    revealed = true;
    log(`print tapped: ${t}`);
    if (t === "reveal") return show();
    setStrip("hmm…", "hmm");
    hooks.onPeek?.(true);
  }

  bridge.onVision((e: VisionEvent) => {
    if (state !== "developing") return;
    const a = readAnswer(e, requestId);
    if (a) arrived(a);
  });

  function resetPhoto() {
    requestId++;
    clearTimeout(answerTimer);
    if (revealed && !answer) hooks.onPeek?.(false);
    answer = null;
    revealed = false;
    if (polaroid.classList.contains("up")) polaroid.classList.add("away");
    else polaroid.className = "polaroid";
    const url = photoUrl;
    photoUrl = "";
    setTimeout(() => {
      if (url) URL.revokeObjectURL(url);
      if (photoUrl) return; // a new photo is up already
      polaroid.className = "polaroid";
      dev.removeAttribute("src");
      raw.removeAttribute("src");
      setStrip("");
    }, 280);
  }

  function close() {
    if (state === "closed") return;
    session++;
    go("close");
    stopStream();
    resetPhoto(); // a late answer is dropped silently
    el.classList.remove("shown");
    setTimeout(() => {
      if (state !== "closed") return; // reopened meanwhile
      el.classList.remove("on");
    }, 280);
    hooks.onHide?.();
  }

  // Touch: tap the viewfinder = shutter; tap the print = reveal; tap outside it or swipe down = close.
  let down: { x: number; y: number } | null = null;
  el.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY };
  });
  el.addEventListener("pointercancel", () => (down = null));
  el.addEventListener("pointerup", (e) => {
    if (!down) return;
    const dy = e.clientY - down.y;
    const moved = Math.hypot(e.clientX - down.x, dy) > 24;
    down = null;
    if (dy > SWIPE_CLOSE_PX) return close();
    if (moved) return;
    if (state === "preview") return shutter();
    if (polaroid.contains(e.target as Node) && polaroid.classList.contains("up")) return tapPrint();
    if (state !== "opening" && state !== "capturing") close();
  });
  // The app went to the background: let the camera go (not while opening: see closesWhenHidden).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && closesWhenHidden(state)) close();
    else if (document.hidden && state === "opening") log("hidden while opening (permission dialog?): kept");
  });

  return {
    open: (beat?: Promise<unknown>) => void open(beat),
    warm: () => void makeClick(),
    shutter,
    close,
    get state() {
      return state;
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A static film-grain tile (made once; the layer moves, the pixels never change). */
function grainTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 96;
  const g = c.getContext("2d")!;
  const img = g.createImageData(96, 96);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

let audio: AudioContext | null = null;
let noise: AudioBuffer | null = null;

/**
 * The audio context and the noise buffer, made once in idle time after start-up (or at the first open or photo, if
 * that comes earlier), so neither the camera reveal nor the shutter pays for them.
 */
function makeClick(): boolean {
  try {
    audio ??= new AudioContext();
    if (!noise) {
      noise = audio.createBuffer(1, Math.ceil(audio.sampleRate * 0.008), audio.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    }
    return true;
  } catch {
    return false; // no sound is fine
  }
}

/** The context starts suspended (no gesture at start-up): resume it at open and on the shutter tap. */
function resumeClick(): boolean {
  if (!makeClick() || !audio) return false;
  if (audio.state === "suspended") void audio.resume().catch(() => undefined);
  return true;
}

/** The shutter sound: an 8 ms noise burst and a 40 ms decaying tick. */
function click() {
  try {
    if (!resumeClick() || !audio || !noise) return;
    const t = audio.currentTime;
    const burst = audio.createBufferSource();
    burst.buffer = noise;
    const bg = audio.createGain();
    bg.gain.value = 0.5;
    burst.connect(bg).connect(audio.destination);
    burst.start(t);
    const tick = audio.createOscillator();
    tick.type = "square";
    tick.frequency.setValueAtTime(1500, t + 0.006);
    const tg = audio.createGain();
    tg.gain.setValueAtTime(0.0001, t);
    tg.gain.setValueAtTime(0.25, t + 0.006);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.046);
    tick.connect(tg).connect(audio.destination);
    tick.start(t + 0.006);
    tick.stop(t + 0.05);
  } catch {
    // no sound is fine
  }
}
