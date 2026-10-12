// The "sun card": a one-line retro card with the next sunrise or sunset and the moon, shown on a "sun" / "time" request.
// Built from the dark-theme tokens in web/index.html; animates transform and opacity only.
import { DRESDEN, sunLine } from "./sun";

// It sits in the metal meter's slot (metal.ts), centred above the voice strip, on one line: clear of Val's legs.
const CSS = `
#sun-card{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 7% + 46px);box-sizing:border-box;
min-width:236px;max-width:calc(100% - 32px);height:40px;padding:0 14px;text-align:center;
background:var(--bg,#000);border:2px solid var(--cream,#f4ead5);color:var(--pink,#ffb3c8);
font:600 14px/36px var(--mono,ui-monospace,"Roboto Mono","Droid Sans Mono",monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
opacity:0;transform:translate(-50%,6px);pointer-events:none;transition:opacity 180ms var(--out,ease-out),transform 180ms var(--out,ease-out)}
#sun-card.show{opacity:1;transform:translate(-50%,0)}
`;

export interface SunCard {
  /** Show the card for `ms` (Val's spoken line comes from sunSpeech). */
  show(now?: Date, lat?: number, lon?: number, ms?: number): void;
  hide(): void;
}

export function createSunCard(doc: Document = document): SunCard {
  const style = doc.createElement("style");
  style.textContent = CSS;
  doc.head.appendChild(style);
  const card = doc.createElement("div");
  card.id = "sun-card";
  card.setAttribute("role", "status");
  doc.body.appendChild(card);
  let timer = 0;

  const hide = () => {
    clearTimeout(timer);
    card.classList.remove("show");
    doc.body.classList.remove("card-up");
  };

  return {
    hide,
    show(now = new Date(), lat = DRESDEN.lat, lon = DRESDEN.lon, ms = 6000) {
      card.textContent = sunLine(now, lat, lon);
      card.classList.add("show");
      doc.body.classList.add("card-up"); // the idle [TEXT ONLY] tag steps aside
      clearTimeout(timer);
      timer = window.setTimeout(hide, ms);
    },
  };
}
