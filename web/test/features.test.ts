import { test } from "node:test";
import assert from "node:assert/strict";
import { featureBusy, featureLabel, featureStep, homeState, mustBeDown, type FeatureEffect, type FeatureEvent, type FeatureState } from "../src/features";

/** Run events in order; returns the final state and every effect (notes left out unless asked). */
function run(s: FeatureState, events: FeatureEvent[], notes = false) {
  const effects: FeatureEffect[] = [];
  for (const e of events) {
    const out = featureStep(s, e);
    s = out.state;
    effects.push(...out.effects.filter((x) => notes || x.do !== "note"));
  }
  return { s, effects };
}
const open = (kind: "camera" | "map" | "metal", place?: string): FeatureEvent => ({ type: "request", req: place ? { kind, place } : { kind } });

test("home → revealing → open, and back home on close", () => {
  let { s, effects } = run(homeState(), [open("map")]);
  assert.equal(featureLabel(s), "revealing(map)");
  assert.deepEqual(effects, [{ do: "reveal", req: { kind: "map" }, token: 1 }]);
  ({ s, effects } = run(s, [{ type: "revealed", token: 1 }]));
  assert.equal(featureLabel(s), "open(map)");
  assert.deepEqual(effects, [{ do: "show", req: { kind: "map" }, token: 1 }]);
  ({ s, effects } = run(s, [{ type: "closing", kind: "map" }, { type: "closed", kind: "map" }]));
  assert.equal(featureLabel(s), "home");
  assert.deepEqual(effects, [{ do: "end", kind: "map" }]);
  assert.equal(featureBusy(s), false);
});

test("map → camera: the map closes fully, Val settles, then the camera reveals", () => {
  let { s, effects } = run(homeState(), [open("map"), { type: "revealed", token: 1 }, open("camera")]);
  assert.equal(featureLabel(s), "closing(map)");
  assert.deepEqual(effects.at(-1), { do: "close", kind: "map", spoken: false });
  ({ s, effects } = run(s, [{ type: "closed", kind: "map" }]));
  assert.equal(featureLabel(s), "home");
  assert.equal(effects[0].do, "end");
  assert.equal(effects[1].do, "settle");
  ({ s, effects } = run(s, [{ type: "settled" }]));
  assert.equal(featureLabel(s), "revealing(camera)");
  assert.deepEqual(effects, [{ do: "reveal", req: { kind: "camera" }, token: 2 }]);
});

test("camera → map, and a late camera reveal after the take-over is ignored", () => {
  let { s } = run(homeState(), [open("camera"), open("map")]); // taken over while still revealing
  assert.equal(featureLabel(s), "closing(camera)");
  let effects: FeatureEffect[];
  ({ s, effects } = run(s, [{ type: "revealed", token: 1 }], true)); // the camera's late onShow
  assert.equal(featureLabel(s), "closing(camera)");
  assert.equal(effects[0].do, "note");
  ({ s } = run(s, [{ type: "closed", kind: "camera" }, { type: "settled" }]));
  assert.equal(featureLabel(s), "revealing(map)");
  ({ s } = run(s, [{ type: "revealed", token: 1 }])); // stale token again
  assert.equal(featureLabel(s), "revealing(map)");
  ({ s } = run(s, [{ type: "revealed", token: 2 }]));
  assert.equal(featureLabel(s), "open(map)");
});

test("metal → map: the detector is switched off before the scroll comes out", () => {
  let { s, effects } = run(homeState(), [open("metal"), { type: "revealed", token: 1 }, open("map", "Zwinger")]);
  assert.deepEqual(effects.at(-1), { do: "close", kind: "metal", spoken: false });
  ({ s, effects } = run(s, [{ type: "closed", kind: "metal" }, { type: "settled" }]));
  assert.deepEqual(effects.at(-1), { do: "reveal", req: { kind: "map", place: "Zwinger" }, token: 2 });
});

test("a double press while the camera is revealing is ignored; once open it takes the photo", () => {
  let { s, effects } = run(homeState(), [open("camera"), open("camera")], true);
  assert.equal(featureLabel(s), "revealing(camera)");
  assert.equal(effects.filter((e) => e.do === "reveal").length, 1);
  assert.match((effects.at(-1) as { text: string }).text, /ignored camera/);
  ({ s, effects } = run(s, [{ type: "revealed", token: 1 }, open("camera")]));
  assert.deepEqual(effects.at(-1), { do: "shutter" });
});

test("back while revealing cancels the reveal and drops anything queued", () => {
  let { s, effects } = run(homeState(), [open("map"), { type: "back", spoken: true }]);
  assert.equal(featureLabel(s), "closing(map)");
  assert.deepEqual(effects.at(-1), { do: "close", kind: "map", spoken: true });
  ({ s } = run(s, [open("camera"), { type: "back" }, { type: "closed", kind: "map" }]));
  assert.equal(featureLabel(s), "home");
  assert.equal(s.queued, null);
});

test("a voice command inside the map routes there; one for the camera switches features", () => {
  let { s, effects } = run(homeState(), [open("map"), { type: "revealed", token: 1 }, open("map", "Zwinger")]);
  assert.equal(featureLabel(s), "open(map)");
  assert.deepEqual(effects.at(-1), { do: "goTo", place: "Zwinger" });
  ({ s, effects } = run(s, [open("map")], true)); // "where am I" again: nothing to do
  assert.equal(featureLabel(s), "open(map)");
  assert.equal(effects[0].do, "note");
  ({ s } = run(s, [open("camera")]));
  assert.equal(featureLabel(s), "closing(map)");
  assert.deepEqual(s.queued, { kind: "camera" });
});

test("a place asked for while the scroll unrolls is kept for the open", () => {
  const { s, effects } = run(homeState(), [open("map"), open("map", "Frauenkirche"), { type: "revealed", token: 1 }]);
  assert.deepEqual(effects.at(-1), { do: "show", req: { kind: "map", place: "Frauenkirche" }, token: 1 });
  assert.equal(featureLabel(s), "open(map)");
});

test("closes for a feature that is not the current one are ignored", () => {
  const { s } = run(homeState(), [open("map"), { type: "revealed", token: 1 }, { type: "closed", kind: "camera" }]);
  assert.equal(featureLabel(s), "open(map)");
});

// ---- The state machine against a model of the page: overlays come up on "show", go down on "close", and the async
// replies (a reveal finishing, a close finishing, the settle timer) arrive later, in order, possibly stale.
type Kind = "camera" | "map" | "metal";
class World {
  s = homeState();
  up = new Set<Kind>(); // overlays on screen
  pending: FeatureEvent[] = [];
  ended: Kind[] = [];
  reconciled = 0; // overlays main.ts's reconcileFeatures would have had to tear down (must stay 0)
  send(e: FeatureEvent) {
    const out = featureStep(this.s, e);
    this.s = out.state;
    for (const fx of out.effects) {
      if (fx.do === "reveal") this.pending.push({ type: "revealed", token: fx.token });
      else if (fx.do === "show") this.up.add(fx.req.kind);
      else if (fx.do === "close") {
        this.up.delete(fx.kind);
        this.pending.push({ type: "closed", kind: fx.kind });
      } else if (fx.do === "end") this.ended.push(fx.kind);
      else if (fx.do === "settle") this.pending.push({ type: "settled" });
    }
    for (const k of mustBeDown(this.s)) if (this.up.delete(k)) this.reconciled++;
    return this;
  }
  tick(n = 1) {
    while (n-- > 0 && this.pending.length) this.send(this.pending.shift()!);
    return this;
  }
  flush() {
    return this.tick(Infinity);
  }
  get label() {
    return featureLabel(this.s);
  }
}
const req = (kind: Kind): FeatureEvent => ({ type: "request", req: { kind } });
const BACK: FeatureEvent = { type: "back" };

test("map → camera → back lands home with the map hidden (never back on the map)", () => {
  const w = new World().send(req("map")).flush();
  assert.equal(w.label, "open(map)");
  w.send(req("camera")).flush();
  assert.equal(w.label, "open(camera)");
  assert.deepEqual([...w.up], ["camera"]);
  w.send(BACK).flush();
  assert.equal(w.label, "home");
  assert.equal(w.up.size, 0);
  assert.deepEqual(w.ended, ["map", "camera"]);
  assert.equal(w.reconciled, 0);
});

test("camera → map → back lands home", () => {
  const w = new World().send(req("camera")).flush().send(req("map")).flush();
  assert.equal(w.label, "open(map)");
  w.send(BACK).flush();
  assert.equal(w.label, "home");
  assert.equal(w.up.size, 0);
  assert.equal(w.reconciled, 0);
});

test("a quick open-close of each feature, and back during each reveal, land home with nothing up", () => {
  for (const kind of ["camera", "map", "metal"] as const) {
    const quick = new World().send(req(kind)).flush().send(BACK).flush();
    assert.equal(quick.label, "home", kind);
    assert.equal(quick.up.size, 0, kind);
    const early = new World().send(req(kind)).send(BACK).flush(); // back before the reveal finished
    assert.equal(early.label, "home", kind);
    assert.equal(early.up.size, 0, kind);
    assert.deepEqual(early.ended, [kind]);
  }
});

test("back while the next feature waits for the old one's stow: home, nothing opens later", () => {
  const w = new World().send(req("map")).flush().send(req("camera")).tick(1); // the map closed, the settle pending
  assert.equal(w.label, "home");
  assert.deepEqual(w.s.queued, { kind: "camera" });
  w.send(BACK).flush();
  assert.equal(w.label, "home");
  assert.equal(w.up.size, 0);
});

test("rapid presses in every order and timing never leave an overlay up that is not the current feature", () => {
  const acts = [req("map"), req("camera"), BACK];
  const gaps = [0, 1, Infinity];
  let runs = 0;
  for (let a = 0; a < 81; a++) {
    for (let g = 0; g < 81; g++) {
      const w = new World();
      for (let i = 0, ai = a, gi = g; i < 4; i++, ai = Math.floor(ai / 3), gi = Math.floor(gi / 3)) {
        w.send(acts[ai % 3]).tick(gaps[gi % 3]);
        for (const k of w.up) assert.ok(!mustBeDown(w.s).includes(k));
      }
      w.flush().send(BACK).flush();
      const why = `acts ${a} gaps ${g}`;
      assert.equal(w.label, "home", why);
      assert.equal(w.up.size, 0, why);
      assert.equal(w.s.queued, null, why);
      assert.equal(w.reconciled, 0, why); // the state machine alone keeps the screen right
      runs++;
    }
  }
  assert.equal(runs, 6561);
});

test("mustBeDown keeps only the current feature, closing included", () => {
  assert.deepEqual(mustBeDown(homeState()), ["camera", "map", "metal"]);
  const w = new World().send(req("map")).flush().send(req("camera"));
  assert.equal(w.label, "closing(map)");
  assert.deepEqual(mustBeDown(w.s), ["camera", "metal"]);
});
