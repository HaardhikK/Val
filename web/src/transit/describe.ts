// What Val says about a journey or the next departures: short, spoken, built only from the planner's values.
import type { Mode } from "./decode";
import { clockText, type Departure, type Journey, type PlanResult, type RideLeg } from "./raptor";

/** Per-session state: the "timetable, not live" note is said once per session. */
export interface SpeechSession {
  liveNoteGiven: boolean;
}

const MODE_WORD: Record<Mode, string> = { 0: "tram", 1: "bus", 2: "train", 3: "ferry", 4: "line" };

/** A spoken journey stays under this many characters; longer ones are summarised (the card keeps every leg). */
export const MAX_SPOKEN = 180;

/** "Dresden Postplatz" → "Postplatz": Val is always in Dresden. */
export const spokenStop = (name: string) => name.replace(/^Dresden\s+|,\s*Dresden$/g, "");

/** Timetable abbreviations, as words for the voice (whole words only; "Str." also ends a word: "Hellerhofstr."). */
const ABBREVIATIONS: [RegExp, string][] = [
  [/^Bf\.\s+(.+)$/, "$1 station"],
  [/^Btf\.\s+(.+)$/, "$1 depot"],
  [/(?<=\s)(?:ü|üb)\.\s+Bf\.\s+(.+)$/, "via $1 station"],
  [/\bBf\.(?=\s|$)/g, "station"],
  [/\bBtf\.(?=\s|$)/g, "depot"],
  [/(?<=\s|^)(?:ü|üb)\.(?=\s)/g, "via"],
  [/str\.(?=\s|$)/g, "straße"],
  [/\bStr\.(?=\s|$)/g, "Straße"],
  [/\bPl\.(?=\s|$)/g, "Platz"],
  [/\bHbf\b\.?/g, "Hauptbahnhof"],
  [/\bKleinzsch\./g, "Kleinzschachwitz"],
  [/\bKleinnaund\./g, "Kleinnaundorf"],
  [/\bSchneebg\./g, "Schneeberg"],
  [/\bFußw\./g, "Fußweg"],
  [/\bWanderw\./g, "Wanderweg"],
  [/(?<=\s)z\.(?=\s)/g, "zum"],
];

/**
 * A headsign or stop name as Val says it: no "Dresden", no "-> Li.6" (the line it becomes), no bracketed
 * platform notes, abbreviations spelled out, and no shouting ("MESSE DRESDEN" → "Messe").
 */
export function spokenName(raw: string): string {
  let s = raw.replace(/\s*->\s*Li\.?\s*\w+/g, "").replace(/\s*\([^)]*\)/g, "");
  s = s.replace(/\p{Lu}{3,}/gu, (w) => w.charAt(0) + w.slice(1).toLowerCase());
  s = spokenStop(s.replace(/\s+Dresden$/, "").trim());
  for (const [re, to] of ABBREVIATIONS) s = s.replace(re, to);
  return s.replace(/\s+/g, " ").trim();
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sameName = (a: string, b: string) => a.localeCompare(b, "de", { sensitivity: "base" }) === 0;

function liveNote(session: SpeechSession): string {
  if (session.liveNoteGiven) return "";
  session.liveNoteGiven = true;
  return " (timetable, not live)";
}

/** "towards Pennrich", or nothing when the headsign is where we board (a loop line) or empty. */
function towards(leg: RideLeg): string {
  const h = spokenName(leg.headsign);
  return h && !sameName(h, spokenName(leg.fromStop.name)) ? ` towards ${h}` : "";
}

/**
 * The legs as spoken phrases. `detail` 0: every leg; 1: no headsign after the first ride; 2: the first two rides,
 * then "one more change"; 3: the first ride, then the number of changes; 4: as 3, without its headsign.
 */
function phrases(j: Journey, detail: number): string[] {
  const rides = j.legs.filter((l): l is RideLeg => !l.walk);
  const keep = detail >= 3 ? 1 : detail >= 2 ? 2 : rides.length;
  const parts: string[] = [];
  let n = 0;
  for (let i = 0; i < j.legs.length; i++) {
    const leg = j.legs[i];
    if (leg.walk) {
      if (n >= keep && n < rides.length) continue; // inside the summarised part
      // The ride after it names its stop; only the last walk says where it goes (nowhere: the destination).
      parts.push(`${i === j.legs.length - 1 && i > 0 ? "then walk" : "walk"} ${plural(leg.minutes, "minute")}`);
      continue;
    }
    if (n >= keep) {
      if (n === keep) {
        const more = rides.length - keep;
        parts.push(`then ${more === 1 ? "one more change" : `${more} more changes`}`);
      }
      n++;
      continue;
    }
    const from = spokenName(leg.fromStop.name);
    const to = spokenName(leg.toStop.name);
    const last = n === rides.length - 1;
    const head = (detail >= 1 && n > 0) || detail >= 4 ? "" : towards(leg);
    const line = `${MODE_WORD[leg.mode]} ${leg.line}`;
    let p = n === 0 ? `take ${line} from ${from} at ${clockText(leg.depart)}${head}` : `change at ${from} to ${line} at ${clockText(leg.depart)}${head}`;
    // Where to get off: always on the last ride; on the others only in full detail, when a walk to another stop follows.
    const walkNext = j.legs[i + 1]?.walk === true;
    if (last || (detail === 0 && walkNext)) p += head && sameName(head.slice(" towards ".length), to) ? " to the end of the line" : `, get off at ${to}`;
    parts.push(p);
    n++;
  }
  return parts;
}

/** One spoken line for a journey, e.g. "Walk 4 minutes, take tram 1 from Postplatz at 22:14 towards Leutewitz …". */
export function describeJourney(j: Journey, session: SpeechSession): string {
  const note = session.liveNoteGiven ? "" : " (timetable, not live)";
  let text = "";
  for (let detail = 0; detail <= 4; detail++) {
    const body = phrases(j, detail).join(", ");
    text = `${body.charAt(0).toUpperCase()}${body.slice(1)}. You'll be there at ${clockText(j.arrive)}`;
    if (text.length + note.length + 1 <= MAX_SPOKEN) return `${text}${liveNote(session)}.`;
  }
  return `${text}.`; // still long (long stop names): the note waits for a shorter line
}

/** "It's quicker to walk, about 9 minutes." */
export const walkLine = (minutes: number) => `It's quicker to walk, about ${plural(minutes, "minute")}.`;

/** The line for a plan result: the best journey, or why there is none. */
export function describePlan(result: PlanResult, session: SpeechSession): string {
  if (result.journeys) return describeJourney(result.journeys[0], session);
  switch (result.reason) {
    case "timetable expired":
      return "My timetable has expired, so I can't plan trams and buses any more.";
    case "no stops nearby":
      return `There's no stop close enough. On foot it's about ${plural(result.walkMinutes, "minute")}.`;
    default:
      return `I can't find a connection right now. On foot it's about ${plural(result.walkMinutes, "minute")}.`;
  }
}

/**
 * "Next from Postplatz: tram 1 towards Leutewitz at 12:03, in 4 minutes; …". `missing`: the mode asked for
 * ("tram") when none of it leaves soon, so the list is of the other modes.
 */
export function describeDepartures(stopName: string, deps: Departure[] | null, session: SpeechSession, missing?: string): string {
  const stop = spokenName(stopName);
  if (deps === null) return "My timetable has expired, so I don't know the departures any more.";
  if (deps.length === 0) return `Nothing leaves ${stop} for now.`;
  const items = deps.map((d) => {
    const when = d.inMinutes === 0 ? "now" : `in ${plural(d.inMinutes, "minute")}`;
    const h = spokenName(d.headsign);
    return `${MODE_WORD[d.mode]} ${d.line}${h && !sameName(h, stop) ? ` towards ${h}` : ""} at ${clockText(d.depart)}, ${when}`;
  });
  const head = missing ? `No ${missing} soon from ${stop}; the next is ` : `Next from ${stop}: `;
  return `${head}${items.join("; ")}${liveNote(session)}.`;
}
