// Pure parts of the camera: frame size, messages to and from the app, and the viewfinder's state machine.

/** The question sent with a photo (the app caps it at 200 characters). */
export const DESCRIBE_PROMPT = 'What is the main thing in this photo? Answer in one short sentence that starts with "It looks like".';
/** Longest side of the photo sent to the vision model (it uses at most 256 image tokens anyway). */
export const MAX_SIDE = 512;
/** The page gives up waiting for an answer after this long: longer than the app's own 60 s budget (Vision.kt DESCRIBE_BUDGET_MS), so the app's answer or error always arrives first. */
export const ANSWER_TIMEOUT_MS = 75_000;

/** JPEG quality of the photo sent to the vision model (it sees at most 512 px; 0.7 is plenty and encodes faster). */
export const JPEG_QUALITY = 0.7;
/** The print's sepia develop, played once while the Polaroid slides up (cosmetic, never tied to the model). */
export const DEVELOP_MS = 600;
/** The viewfinder fades in over this long, together with Val shrinking into the corner bubble. */
export const VIEWFINDER_FADE_MS = 180;
/** The shutter's edge glow on the viewfinder: short and soft (the real flash is Val's camera, in the bubble). */
export const PULSE_MS = 80;
export const PULSE_OPACITY = 0.35;
/** After the reveal, the viewfinder waits at most this long for the camera's first real frame, then shows anyway. */
export const FIRST_FRAME_GRACE_MS = 1500;

/**
 * Whether the camera lets go when the page is hidden. Not while it is opening: the first open shows Android's camera
 * permission dialog, which pauses the app (the page goes hidden), and closing then would throw the stream away.
 */
export function closesWhenHidden(state: CameraState): boolean {
  return state !== "opening" && state !== "closed";
}

/** Scale a camera frame so its longest side is at most `max`, keeping the aspect; null for an empty frame. */
export function frameSize(w: number, h: number, max = MAX_SIDE): { w: number; h: number } | null {
  if (!(w > 0) || !(h > 0)) return null;
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(2, Math.round((w * k) / 2) * 2), h: Math.max(2, Math.round((h * k) / 2) * 2) };
}

/** Page → app: "what is this?" with the JPEG (the data-URL prefix is stripped; the app wants plain base64). */
export function describeMessage(id: number, dataUrl: string, prompt = DESCRIBE_PROMPT) {
  const comma = dataUrl.indexOf(",");
  const image = dataUrl.startsWith("data:") && comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return { type: "describe" as const, id, image, prompt: prompt.slice(0, 200) };
}

export type VisionAnswer = { ok: true; text: string; ms: number } | { ok: false; reason: string };

/** App → page: the answer for request `id`, or null if the message is for another (older) photo or malformed. */
export function readAnswer(msg: { type?: unknown; id?: unknown; text?: unknown; ms?: unknown; reason?: unknown }, id: number): VisionAnswer | null {
  if (Number(msg.id) !== id) return null;
  if (msg.type === "vision" && typeof msg.text === "string" && msg.text.trim()) {
    return { ok: true, text: caption(msg.text), ms: Number(msg.ms) || 0 };
  }
  if (msg.type === "visionError" || msg.type === "vision") return { ok: false, reason: String(msg.reason ?? "no answer") };
  return null;
}

/** Tidy a model answer for the Polaroid strip: one line, at most ~140 characters, ends with punctuation. */
export function caption(text: string, max = 140): string {
  let t = text.replace(/\s+/g, " ").trim();
  if (t.length > max) t = `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
  if (t && !/[.!?…]$/.test(t)) t += ".";
  return t;
}

/** What the strip says when there is no answer (kept friendly; the reason goes to the log). */
export function errorCaption(reason: string): string {
  if (/missing/.test(reason)) return "My eyes aren't installed yet.";
  if (/busy/.test(reason)) return "Still thinking about the last one…";
  return "Hmm, I couldn't make that out.";
}

export type CameraState = "closed" | "opening" | "preview" | "capturing" | "developing" | "done" | "error";
export type CameraEvent = "open" | "ready" | "shutter" | "sent" | "answer" | "fail" | "close";

// developing: the Polaroid is up and the vision model works in the background; done: its answer (or its error) is
// in hand, shown only when the photo is tapped. error: the camera or the photo itself failed.
const NEXT: Record<CameraState, Partial<Record<CameraEvent, CameraState>>> = {
  closed: { open: "opening" },
  opening: { ready: "preview", fail: "error", close: "closed" },
  preview: { shutter: "capturing", fail: "error", close: "closed" },
  capturing: { sent: "developing", fail: "error", close: "closed" },
  developing: { answer: "done", open: "opening", close: "closed" },
  done: { close: "closed", open: "opening" },
  error: { close: "closed", open: "opening" },
};

/** The viewfinder's state machine: open → preview → capturing → developing → done / error. Unknown moves are ignored. */
export function transition(state: CameraState, event: CameraEvent): CameraState {
  return NEXT[state][event] ?? state;
}

/**
 * A tap on the Polaroid: reveal the answer if it is in, otherwise a short "hmm…" until it arrives (it then shows at
 * once). Nothing while the photo is still being taken, nor once the answer is showing.
 */
export function polaroidTap(state: CameraState, revealed: boolean): "reveal" | "hmm" | "none" {
  if (revealed) return "none";
  if (state === "done") return "reveal";
  if (state === "developing") return "hmm";
  return "none";
}

export type TimelineMark = "gum" | "play" | "firstFrame" | "beat" | "shown" | "faded";

/** The camera-open timeline as one log line: each mark in ms since the open began ("-" if it never happened). */
export function timelineLine(t0: number, marks: Partial<Record<TimelineMark, number>>, how = ""): string {
  const f = (k: TimelineMark) => (marks[k] === undefined ? "-" : String(Math.round(marks[k]! - t0)));
  const lag = marks.shown !== undefined && marks.beat !== undefined ? ` beatToVisible=${Math.round(marks.shown - marks.beat)}` : "";
  return `camera timeline: gum=${f("gum")} play=${f("play")} firstFrame=${f("firstFrame")}${how ? `(${how})` : ""} beat=${f("beat")} visible=${f("shown")} faded=${f("faded")}${lag}`;
}
