// The knock seismograph: a thin cream line along the bottom edge that scrolls while knocks come in, with each knock
// ringing in amber, and fades out 2 s after the last one. One small canvas; it draws only while visible, and nothing is
// allocated per frame (the trace lives in SeismoTrace's fixed buffers).
import { pixelRatio } from "../device";
import { SEISMO_POINTS, SeismoTrace } from "../knock";

const CSS = `
#seismo{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 14px);width:min(240px,calc(100% - 32px));height:28px;
transform:translateX(-50%);opacity:0;pointer-events:none;z-index:5}
#seismo canvas{display:block;width:100%;height:100%}
#seismo span{position:absolute;left:0;bottom:100%;margin-bottom:2px;font:600 9px/1 var(--mono,monospace);letter-spacing:.16em;color:var(--text-3,rgba(244,234,213,.45))}
`;

export interface Seismograph {
  knock(strength: number): void;
  /** Call once per rendered frame. */
  update(now: number): void;
}

export function createSeismograph(doc: Document = document): Seismograph {
  const style = doc.createElement("style");
  style.textContent = CSS;
  doc.head.appendChild(style);
  // The strip: a tiny KNOCK label over the trace; the whole strip fades in and out together.
  const strip = doc.createElement("div");
  strip.id = "seismo";
  strip.setAttribute("aria-hidden", "true");
  const label = doc.createElement("span");
  label.textContent = "KNOCK";
  const canvas = doc.createElement("canvas");
  strip.append(label, canvas);
  doc.body.appendChild(strip);
  const g = canvas.getContext("2d")!;
  const css = getComputedStyle(doc.documentElement);
  const cream = css.getPropertyValue("--cream").trim() || "#f4ead5";
  const amber = css.getPropertyValue("--amber").trim() || "#ffb000";
  const trace = new SeismoTrace();
  let w = 0;
  let h = 0;
  let shownOpacity = -1;

  const fit = () => {
    const ratio = pixelRatio();
    w = Math.round(canvas.clientWidth * ratio);
    h = Math.round(canvas.clientHeight * ratio);
    canvas.width = w;
    canvas.height = h;
  };

  /** One pass over the strip: the whole line (amber = false), or only the knock segments (amber = true). */
  const stroke = (amber: boolean) => {
    g.beginPath();
    const mid = h / 2;
    const amp = h * 0.45;
    const dx = w / (SEISMO_POINTS - 1);
    let pen = false;
    for (let i = 0; i < SEISMO_POINTS; i++) {
      const k = (trace.head + i) % SEISMO_POINTS;
      const x = i * dx;
      const y = mid - trace.value[k] * amp;
      const on = !amber || trace.spike[k] === 1;
      if (on && pen) g.lineTo(x, y);
      else if (on) g.moveTo(x, y);
      pen = on;
    }
    g.stroke();
  };

  return {
    knock(strength) {
      if (w === 0) fit();
      trace.kick(performance.now(), strength);
    },
    update(now) {
      const visible = trace.advance(now);
      const o = visible ? trace.opacity(now) : 0;
      if (Math.abs(o - shownOpacity) > 0.02 || (o === 0 && shownOpacity !== 0)) {
        strip.style.opacity = o.toFixed(2); // only written when it changes: no style work on most frames
        shownOpacity = o;
      }
      if (!visible) return;
      g.clearRect(0, 0, w, h);
      g.lineJoin = "round";
      g.lineWidth = 1.5;
      g.strokeStyle = cream;
      stroke(false);
      g.lineWidth = 2;
      g.strokeStyle = amber;
      stroke(true);
    },
  };
}
