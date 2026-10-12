// The retro camera's look, injected once as a <style> block. Dark theme only; animations use transform and
// opacity only (no filters animate, no backdrop-filter), so the WebView compositor runs them off the main thread.

import { DEVELOP_MS, VIEWFINDER_FADE_MS } from "./logic";

const CSS = `
#cam {
  position: fixed; inset: 0; z-index: 30; display: none; overflow: hidden;
  background: #000; opacity: 0; transition: opacity ${VIEWFINDER_FADE_MS}ms var(--out, ease-out);
  font-family: var(--mono, ui-monospace, "Roboto Mono", "Droid Sans Mono", monospace); color: var(--cream, #f4ead5);
  touch-action: none; pointer-events: none;
}
/* on: laid out (invisible) from the start of Val's reveal, so the stream and its first frame warm up behind him. */
#cam.on { display: block; }
#cam.shown { opacity: 1; pointer-events: auto; }
#cam video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity 160ms ease-out; }
#cam.live video { opacity: 1; }
#cam .vf { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity 160ms ease-out; }
#cam.live .vf { opacity: 1; }
#cam .vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,.55) 100%); }
/* One 96 px tile of bleed and px shifts inside it: a -20% inset made a layer 1.4× the screen on each axis to raster. */
#cam .grain { position: absolute; inset: -96px; opacity: .06; background-size: 96px 96px; animation: cam-grain .5s steps(4) infinite; will-change: transform; }
@keyframes cam-grain {
  0% { transform: translate(0, 0); } 25% { transform: translate(-67px, 38px); }
  50% { transform: translate(48px, -58px); } 75% { transform: translate(-29px, -19px); } 100% { transform: translate(0, 0); }
}
#cam .corner { position: absolute; width: 24px; height: 24px; border: 0 solid var(--pink, #ffb3c8); }
#cam .corner.tl { top: 24px; left: 24px; border-top-width: 2px; border-left-width: 2px; }
#cam .corner.tr { top: 24px; right: 24px; border-top-width: 2px; border-right-width: 2px; }
#cam .corner.bl { bottom: 24px; left: 24px; border-bottom-width: 2px; border-left-width: 2px; }
#cam .corner.br { bottom: 24px; right: 24px; border-bottom-width: 2px; border-right-width: 2px; }
#cam .rec { position: absolute; top: 30px; right: 60px; display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--amber, #ffb000); }
#cam .rec i { width: 8px; height: 8px; border-radius: 50%; background: var(--amber, #ffb000); animation: cam-blink 1s steps(1) infinite; }
@keyframes cam-blink { 50% { opacity: .15; } }
#cam .meta { position: absolute; left: 0; right: 0; bottom: 30px; text-align: center; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-3, rgba(244, 234, 213, .45)); }
/* The shutter: never a white screen. Val's camera flashes in the bubble; the viewfinder's edges glow cream, briefly. */
#cam .pulse { position: absolute; inset: 0; opacity: 0; pointer-events: none; will-change: opacity;
  background: radial-gradient(ellipse at center, rgba(244,234,213,0) 52%, rgba(244,234,213,.9) 100%); }
#cam .msg { position: absolute; left: 24px; right: 24px; top: 40%; text-align: center; font-size: 14px; line-height: 1.45; color: var(--text-2, rgba(244, 234, 213, .72)); }
#cam .msg .note { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 18px 16px; border: 2px solid var(--cream, #f4ead5); background: #000; }
#cam .msg .ico { display: block; width: 56px; height: 32px; box-sizing: border-box; border: 2px solid var(--pink, #ffb3c8);
  color: var(--pink, #ffb3c8); font: 600 14px/28px var(--mono, monospace); letter-spacing: .1em; }
#cam .msg b { font-size: 11px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--amber, #ffb000); }
#cam .hint { position: absolute; left: 0; right: 0; bottom: 50px; text-align: center; font-size: 10px; font-weight: 600; letter-spacing: .16em;
  text-transform: uppercase; color: var(--text-2, rgba(244, 234, 213, .72)); opacity: .7; }
#cam .polaroid {
  position: absolute; left: 50%; top: 50%; width: min(76vw, 320px);
  padding: 12px 12px 0; background: var(--cream, #f4ead5); border-radius: 0;
  transform: translate(-50%, 120vh) rotate(-6deg); opacity: 0;
  transition: transform 560ms var(--spring, cubic-bezier(.34, 1.56, .64, 1)), opacity 120ms linear;
}
#cam .polaroid.up { transform: translate(-50%, -54%) rotate(-1.5deg); opacity: 1; }
#cam .polaroid.away { transform: translate(-50%, 120vh) rotate(4deg); transition: transform 280ms ease-in; }
#cam .photo { position: relative; aspect-ratio: 1 / 1; overflow: hidden; background: #111; }
#cam .photo img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
#cam .photo img.raw { filter: sepia(1) brightness(.6); opacity: 1; }
/* A short cosmetic develop while the print slides up; never tied to the vision model's time. */
#cam .photo img.raw.developing { animation: cam-develop ${DEVELOP_MS}ms cubic-bezier(.3, .1, .3, 1) 120ms forwards; }
@keyframes cam-develop { to { opacity: 0; } }
#cam:not(.live) .grain, #cam:not(.live) .rec i { animation-play-state: paused; }
#cam .strip {
  min-height: 72px; padding: 14px 6px 16px; box-sizing: border-box;
  font: 500 15px/1.4 var(--mono, ui-monospace, "Roboto Mono", "Droid Sans Mono", monospace); color: #2a2420;
}
#cam .strip.tap { font-size: 11px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; text-align: center; color: rgba(42, 36, 32, .55); }
#cam .strip.hmm { color: rgba(42, 36, 32, .5); animation: cam-hmm 900ms ease-in-out infinite alternate; }
@keyframes cam-hmm { from { opacity: .45; } to { opacity: 1; } }
`;

export function injectCameraStyle() {
  if (document.getElementById("cam-style")) return;
  const style = document.createElement("style");
  style.id = "cam-style";
  style.textContent = CSS;
  document.head.appendChild(style);
}
