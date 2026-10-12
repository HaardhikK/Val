// Charm's retro map style: the Protomaps basemap layers ("black" flavour, German names) in greys on true
// black with cream labels, trimmed to the layers that show something, with glyphs and sprites served from
// the app's own assets.
import { layers, namedFlavor, type Flavor } from "@protomaps/basemaps";

export const SOURCE = "protomaps";
/** The only glyph stacks shipped in assets/charm/map/fonts/ (build.mjs copies them). */
export const FONTS = ["Noto Sans Regular", "Noto Sans Medium"];

const BG = "#000";
const WATER = "#0a1418";
const GREEN = "#0a120a";
const BUILDING = "#101010";
const MINOR = "#262626";
const MAJOR = "#363636";
const HIGHWAY = "#444";
const FOOTWAY = "#202020"; // paths stay solid and faint: only the route is dotted
const TUNNEL = "#1a1a1a";
const LABEL = "rgba(244, 234, 213, 0.7)"; // cream at 70 %
const LABEL_SOFT = "rgba(244, 234, 213, 0.5)";
const CREAM = "rgba(244, 234, 213, 0.85)";
const HALO = "#000";
const HALO_W = 1.5;

export function charmFlavor(): Flavor {
  const base = namedFlavor("black");
  return {
    ...base,
    background: BG,
    earth: BG,
    park_a: GREEN,
    park_b: GREEN,
    wood_a: GREEN,
    wood_b: GREEN,
    scrub_a: GREEN,
    scrub_b: GREEN,
    zoo: GREEN,
    hospital: BG,
    industrial: BG,
    school: BG,
    military: BG,
    glacier: BG,
    sand: BG,
    beach: BG,
    aerodrome: BG,
    pedestrian: "#0a0a0a",
    pier: MINOR,
    runway: MINOR,
    water: WATER,
    buildings: BUILDING,
    other: FOOTWAY,
    minor_service: MINOR,
    minor_a: MINOR,
    minor_b: MINOR,
    link: MAJOR,
    major: MAJOR,
    highway: HIGHWAY,
    minor_service_casing: BG,
    minor_casing: BG,
    link_casing: BG,
    major_casing_early: BG,
    major_casing_late: BG,
    highway_casing_early: BG,
    highway_casing_late: BG,
    tunnel_other: TUNNEL,
    tunnel_minor: TUNNEL,
    tunnel_link: TUNNEL,
    tunnel_major: TUNNEL,
    tunnel_highway: TUNNEL,
    tunnel_other_casing: BG,
    tunnel_minor_casing: BG,
    tunnel_link_casing: BG,
    tunnel_major_casing: BG,
    tunnel_highway_casing: BG,
    bridges_other: FOOTWAY,
    bridges_minor: MINOR,
    bridges_link: MAJOR,
    bridges_major: MAJOR,
    bridges_highway: HIGHWAY,
    bridges_other_casing: BG,
    bridges_minor_casing: BG,
    bridges_link_casing: BG,
    bridges_major_casing: BG,
    bridges_highway_casing: BG,
    railway: MINOR,
    boundaries: MINOR,
    roads_label_minor: LABEL_SOFT,
    roads_label_minor_halo: HALO,
    roads_label_major: LABEL,
    roads_label_major_halo: HALO,
    ocean_label: LABEL_SOFT,
    subplace_label: LABEL_SOFT,
    subplace_label_halo: HALO,
    city_label: LABEL,
    city_label_halo: HALO,
    state_label: LABEL_SOFT,
    state_label_halo: HALO,
    country_label: LABEL_SOFT,
    address_label: LABEL_SOFT,
    address_label_halo: HALO,
    regular: "Noto Sans Regular",
    bold: "Noto Sans Medium",
    italic: "Noto Sans Regular", // no italic glyphs are shipped
    pois: {
      blue: LABEL_SOFT,
      green: LABEL_SOFT,
      lapis: LABEL_SOFT,
      pink: LABEL_SOFT,
      red: LABEL_SOFT,
      slategray: LABEL_SOFT,
      tangerine: LABEL_SOFT,
      turquoise: LABEL_SOFT,
    },
    landcover: {
      barren: BG,
      farmland: BG,
      forest: GREEN,
      glacier: BG,
      grassland: GREEN,
      scrub: GREEN,
      urban_area: BG,
    },
  };
}

/**
 * Layers that draw nothing on black (casings are background-coloured) or only add clutter in one city:
 * house numbers, one-way arrows, shields, boundaries, country and region names.
 */
const DROPPED = /casing|^roads_oneway$|^roads_shields$|^boundaries|^places_country$|^places_region$|^water_label_ocean$|^address_label$/;

/** The only POIs the basemap draws: big landmarks, as quiet text. Food, shops and stops are left to search. */
export const LANDMARKS = ["attraction", "museum", "theatre", "townhall"];

/**
 * The landmark filter; `hide` drops the route's destination (the X and the card name it), also when the label is a
 * shorter or longer form of its name ("Residenzschloss" for "Residenzschloss Dresden"), so no label sits under the X.
 */
export function poiFilter(hide?: string): unknown[] {
  const f: unknown[] = ["all", ["in", ["get", "kind"], ["literal", LANDMARKS]], [">=", ["zoom"], ["+", ["get", "min_zoom"], 1]]];
  if (hide) {
    const name = ["coalesce", ["get", "name:de"], ["get", "name"], ""];
    f.push(["!", ["any", ["==", name, hide], ["all", [">=", ["length", name], 4], ["any", ["in", name, hide], ["in", hide, name]]]]]);
  }
  return f;
}

/** The basemap layers, trimmed and quietened: fewer layers and symbols mean less work on the old phone. */
export function charmLayers() {
  // The basemap names a Devanagari stack for Hindi labels; we ship no such glyphs, so map it to ours.
  const all = JSON.parse(
    JSON.stringify(layers(SOURCE, charmFlavor(), { lang: "de" })).replace(/Noto Sans Devanagari Regular v1/g, FONTS[0]),
  ) as ReturnType<typeof layers>;
  const kept = all.filter((l) => !DROPPED.test(l.id));
  for (const l of kept) {
    if (l.type !== "symbol") continue;
    const layout = (l.layout ??= {}) as Record<string, unknown>;
    const paint = (l.paint ??= {}) as Record<string, unknown>;
    paint["text-halo-color"] = HALO;
    paint["text-halo-width"] = HALO_W;
    if (l.id === "pois") {
      // Landmarks only, as text: the sprite's coloured icons clashed with the palette.
      l.filter = poiFilter() as typeof l.filter;
      delete layout["icon-image"];
      delete layout["text-variable-anchor"];
      delete layout["text-offset"];
      layout["text-font"] = [FONTS[1]];
      layout["text-size"] = 13;
      layout["text-max-width"] = 9;
      layout["text-padding"] = 8;
      paint["text-color"] = CREAM;
    } else if (l.id === "roads_labels_major") {
      layout["text-size"] = 13;
      paint["text-color"] = LABEL;
    } else if (l.id === "roads_labels_minor") {
      l.minzoom = 16;
      layout["text-size"] = 12;
      paint["text-color"] = LABEL_SOFT;
    } else if (l.id === "places_subplace") {
      // Neighbourhood names: small spaced capitals that sit behind everything else.
      layout["text-size"] = ["interpolate", ["linear"], ["zoom"], 11, 11, 16, 13];
      layout["text-transform"] = "uppercase";
      layout["text-letter-spacing"] = 0.15;
      paint["text-color"] = "rgba(244, 234, 213, 0.4)";
    } else if (l.id === "places_locality") {
      l.maxzoom = 13; // a big "Dresden" over the street map says nothing
    }
  }
  return kept;
}

/**
 * The full style. `base` is the absolute URL of the map asset folder (ending in "/"), because MapLibre
 * resolves glyph and sprite URLs outside the page's base URL.
 */
export function charmStyle(base: string, tilesUrl: string) {
  return {
    version: 8 as const,
    glyphs: `${base}fonts/{fontstack}/{range}.pbf`,
    sprite: `${base}sprites/v4/dark`,
    sources: {
      [SOURCE]: {
        type: "vector" as const,
        url: tilesUrl,
        attribution: "© OpenStreetMap contributors",
      },
    },
    layers: charmLayers(),
  };
}
