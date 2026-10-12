// Bundles the character page into the Android app's assets (one script, old-WebView-safe syntax),
// or, with --tests, compiles the unit tests for `node --test`.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// The phone ships WebView/Chrome 94 and it cannot update (no Play Store account), so target it.
const target = ["chrome94"];
const loader = { ".css": "text" }; // map/view.ts injects MapLibre's stylesheet itself

if (process.argv.includes("--tests")) {
  rmSync(".test-build", { recursive: true, force: true });
  const entryPoints = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);
  await build({ entryPoints, bundle: true, platform: "node", format: "esm", outdir: ".test-build", outExtension: { ".js": ".mjs" }, target: ["node18"], loader });
} else {
  const out = "../android/app/src/main/assets/charm";
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({ entryPoints: ["src/main.ts"], bundle: true, minify: true, format: "iife", target, outfile: `${out}/charm.js`, legalComments: "linked" });
  // The map (MapLibre, tiles, search, routing) is its own script, loaded on the first open (src/map/index.ts).
  await build({ entryPoints: ["src/map/view.ts"], bundle: true, minify: true, format: "iife", globalName: "CharmMapImpl", target, outfile: `${out}/map/map.js`, legalComments: "linked", loader });
  cpSync("index.html", `${out}/index.html`);
  cpSync("public", out, { recursive: true });
  cpSync("CREDITS", `${out}/CREDITS`);
  copyMapData(`${out}/map`);
  console.log(`built ${out}`);
}

/**
 * Offline map data lives in the git-ignored cache (README → Setup), never in git: tiles, glyphs,
 * sprites, and what scripts/build-map-data.py and scripts/build-transit.py derive. CHARM_CACHE points at that
 * cache (default ../.cache).
 */
function copyMapData(dest) {
  const src = resolve(process.env.CHARM_CACHE ?? "../.cache", "downloads/map");
  const items = [
    ["dresden.pmtiles", "dresden.pmtiles"],
    ["assets/fonts", "fonts"],
    ["assets/sprites", "sprites"],
    ["derived/pois.json", "derived/pois.json"],
    ["derived/walk.graph", "derived/walk.graph"],
    ["derived/transit.bin", "derived/transit.bin"],
    ["derived/transit-stops.json", "derived/transit-stops.json"],
  ];
  for (const [from, to] of items) {
    const path = join(src, from);
    if (!existsSync(path)) {
      console.warn(`warning: map data missing, skipped: ${path} (see scripts/build-map-data.py and README → Setup)`);
      continue;
    }
    cpSync(path, join(dest, to), { recursive: true });
  }
}
