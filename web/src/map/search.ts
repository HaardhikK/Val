// Offline place search over pois.json: fuzzy + prefix (MiniSearch), English/German synonyms,
// ranked by text match and distance from where you are.
import MiniSearch, { type Query } from "minisearch";
import { haversine } from "./geo";

export interface PoiDoc {
  v: number;
  cats: string[];
  pois: [name: string, cat: number, lat: number, lon: number][];
}

export interface Result {
  id: number;
  name: string;
  category: string;
  lat: number;
  lon: number;
  /** Metres from the reference point used for ranking. */
  distance: number;
  score: number;
}

/** Words for each category, in English and German, so "Apotheke" or "toilet" finds places without the word in their name. */
const CATEGORY_WORDS: Record<string, string> = {
  station: "station stop haltestelle bahnhof tram bus",
  sight: "sight sightseeing sehenswürdigkeit museum attraction",
  pharmacy: "pharmacy apotheke chemist",
  hospital: "hospital krankenhaus klinik clinic",
  toilets: "toilet toilets wc toilette restroom",
  drinking_water: "drinking water trinkwasser brunnen",
  police: "police polizei",
  building: "building gebäude",
  university: "university universität uni",
  food: "food essen restaurant cafe café",
  supermarket: "supermarket supermarkt shop groceries",
  hotel: "hotel hostel",
  park: "park garten garden",
  area: "area viertel platz",
  street: "street straße strasse",
};

/** Words that name a kind of place rather than a place: such queries rank purely by distance. */
const KIND_WORDS = new Set(Object.values(CATEGORY_WORDS).flatMap((w) => w.split(" ").map((t) => t.replace(/ß/g, "ss"))));

/** Query-side synonyms (both directions are listed explicitly). */
export const SYNONYMS: Record<string, string[]> = {
  pharmacy: ["apotheke"],
  apotheke: ["pharmacy"],
  station: ["bahnhof"],
  bahnhof: ["station"],
  toilet: ["wc", "toilette"],
  toilets: ["wc", "toilette"],
  wc: ["toilet", "toilette"],
  toilette: ["toilet", "wc"],
  hospital: ["krankenhaus"],
  krankenhaus: ["hospital"],
  police: ["polizei"],
  polizei: ["police"],
  water: ["trinkwasser"],
  church: ["kirche"],
  kirche: ["church"],
  street: ["straße"],
  strasse: ["straße"],
  main: ["haupt"],
};

/** Filler words from spoken requests ("the nearest pharmacy", "zur Frauenkirche"). */
const STOPWORDS = new Set([
  "the", "a", "an", "to", "nearest", "closest", "next", "find", "me", "where", "is", "go", "take", "near", "please",
  "der", "die", "das", "zum", "zur", "nach", "zu", "nächste", "nächsten",
]);

/** Lowercase, German-aware: "Straße" and "strasse" meet, accents stay (MiniSearch fuzzy covers ä→a). */
const normalize = (t: string) => t.toLowerCase().replace(/ß/g, "ss");
/** Compound form ("Hygiene-Museum" → "hygienemuseum"), so a spoken compound finds a hyphenated name. */
const compact = (name: string) => normalize(name).replace(/[\s\-–./']+/g, "");

/**
 * The sights most visitors mean (sight-category places with exactly these names): a partial word such as "frauen" or
 * "semper" should land on them before a shop or a sculpture that merely contains it.
 */
const FAMOUS = new Set(
  [
    "Frauenkirche", "Zwinger", "Semperoper", "Residenzschloss Dresden", "Brühlsche Terrasse", "Fürstenzug", "Albertinum",
    "Kreuzkirche", "Kathedrale Ss. Trinitatis", "Goldener Reiter", "Japanisches Palais", "Kunsthofpassage",
    "Pfunds Molkerei", "Yenidze", "Gläserne Manufaktur", "Deutsches Hygiene-Museum", "Loschwitzer Brücke",
    "Militärhistorisches Museum der Bundeswehr", "Schloss Pillnitz",
  ].map(compact),
);

/** How much a category counts beyond its text match: sights first, then the places people walk to. */
const CATEGORY_BOOST: Record<string, number> = { sight: 1.5, park: 1.15, area: 1.1, station: 1.1 };

/**
 * Ranking factor on top of MiniSearch's text score: the name starts with what was typed (×1.5, the whole name ×2),
 * a landmark (×2) or a sight, and shorter names (a long name that merely contains the word ranks lower).
 */
export function nameBoost(name: string, category: string, typed: string): number {
  const c = compact(name);
  const prefix = c === typed ? 2 : typed && c.startsWith(typed) ? 1.5 : 1;
  const landmark = category === "sight" && FAMOUS.has(c) ? 2 : 1;
  const short = 1 / (1 + Math.max(0, c.length - 8) / 30);
  return prefix * landmark * (CATEGORY_BOOST[category] ?? 1) * short;
}

/** Where ranking starts when there is no GPS fix yet: the Neumarkt in the Altstadt. */
export const ALTSTADT = { lat: 51.0519, lon: 13.7415 };

interface Doc {
  id: number;
  name: string;
  compact: string;
  words: string;
}

/**
 * The index is filled in chunks (addChunk), so ~19k places never block the main thread in one go (≈ 0.45 s on the
 * phone); search() finishes whatever is left before it answers.
 */
export class PlaceIndex {
  private readonly ms: MiniSearch<Doc>;
  private added = 0;

  constructor(private readonly data: PoiDoc) {
    this.ms = new MiniSearch<Doc>({
      fields: ["name", "compact", "words"],
      storeFields: [],
      processTerm: (t) => normalize(t),
      searchOptions: {
        boost: { name: 3, compact: 2, words: 1 },
        prefix: (term) => term.length >= 3,
        fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
      },
    });
  }

  get size() {
    return this.data.pois.length;
  }

  /** Every place is in the index. */
  get complete() {
    return this.added >= this.data.pois.length;
  }

  /** Adds up to `n` more places to the index; true once all are in. */
  addChunk(n: number): boolean {
    const { pois, cats } = this.data;
    const end = Math.min(pois.length, this.added + n);
    for (let id = this.added; id < end; id++) {
      const [name, cat] = pois[id];
      this.ms.add({ id, name, compact: compact(name), words: CATEGORY_WORDS[cats[cat]] ?? cats[cat] });
    }
    this.added = end;
    return this.complete;
  }

  /**
   * Best places for the query, nearest first among similar matches. Synonyms expand within a term
   * ("Apotheke" also matches pharmacy), and every query word must match something (AND).
   */
  search(query: string, near: { lat: number; lon: number } = ALTSTADT, limit = 8): Result[] {
    const words = normalize(query)
      .split(/[\s,.;:!?"()]+/)
      .filter((w) => w && !STOPWORDS.has(w));
    if (words.length === 0) return [];
    if (!this.complete) this.addChunk(Infinity);
    // Each word, or any of its synonyms, must match (AND of ORs); if nothing matches every word, any word will do.
    const terms: Query[] = words.map((w) => (SYNONYMS[w] ? { combineWith: "OR", queries: [w, ...SYNONYMS[w]] } : w));
    let hits = this.ms.search({ combineWith: "AND", queries: terms });
    if (hits.length === 0 && words.length > 1) hits = this.ms.search({ combineWith: "OR", queries: terms });
    const kindOnly = words.every((w) => KIND_WORDS.has(w));
    const top = hits.length ? hits[0].score : 1;
    const typed = compact(words.join(""));
    const out: Result[] = [];
    for (const h of kindOnly ? hits : hits.slice(0, 400)) {
      const [name, cat, lat, lon] = this.data.pois[h.id as number];
      const distance = haversine(near.lat, near.lon, lat, lon);
      // Text relevance relative to the best hit, weighted by the name (nameBoost), discounted by distance (2 km halves it).
      const score = ((h.score / top) * nameBoost(name, this.data.cats[cat], typed)) / (1 + distance / 2000);
      out.push({ id: h.id as number, name, category: this.data.cats[cat], lat, lon, distance, score });
    }
    // "pharmacy", "WC", "nearest toilet": the nearest place of that kind wins, whatever its name says.
    if (kindOnly) {
      const kinds = new Set(words.flatMap((w) => [w, ...(SYNONYMS[w] ?? [])].map(normalize)));
      const ofKind = out.filter((r) => (CATEGORY_WORDS[r.category] ?? r.category).replace(/ß/g, "ss").split(" ").some((t) => kinds.has(t)));
      if (ofKind.length) return ofKind.sort((a, b) => a.distance - b.distance).slice(0, limit);
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }
}
