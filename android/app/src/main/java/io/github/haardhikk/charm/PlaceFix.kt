package io.github.haardhikk.charm

import android.content.res.AssetManager
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs

/**
 * Repairs a misheard Dresden place name in the place slot of a navigation, transit or "how far" command (pure,
 * unit-tested). The speech model hears German names as English sounds ("how bun hoff", "noi shtat", "swinger"), so
 * the slot is compared with known names by spelling and by sound:
 * score = 0.5 × normalised Levenshtein of the joined letters + 0.5 × normalised Levenshtein of the Kölner Phonetik codes.
 * - score ≤ [ACCEPT]: the name is replaced outright;
 * - score ≤ [CONFIRM] against a well-known name (core names, aliases, Dresden card names): it is offered with `confirm`
 *   ("Did you mean …?"); a map-only name is never offered, only accepted;
 * - otherwise null: the slot is not a known place (the caller keeps the words as they were).
 */
class PlaceFix(names: Collection<String>, known: Map<String, String> = emptyMap()) {

    /** A repaired place: [name] is lowercase, as the page searches it; [confirm] asks the user first. */
    data class Fix(val name: String, val score: Double, val confirm: Boolean)

    /** One spelling of a place ([joined], [code]) and the name it repairs to. */
    private class Cand(val name: String, val joined: String, val code: String, val known: Boolean)

    private val exact = HashMap<String, String>()
    private val cands: List<Cand>

    init {
        val all = LinkedHashMap<String, Cand>()
        fun add(spelling: String, name: String, isKnown: Boolean) {
            val j = joined(spelling)
            if (j.length < 3) return
            if (isKnown) exact[j] = canonical(name) else exact.putIfAbsent(j, canonical(name))
            if (j.length < MIN_FUZZY_LEN) return
            val prev = all[j]
            if (prev == null || (isKnown && !prev.known)) all[j] = Cand(canonical(name), j, koelner(j), isKnown)
        }
        for (n in names) add(canonical(n), n, false)
        for ((spelling, name) in known) add(spelling, name, true)
        for (n in CORE) add(n, n, true)
        for ((alias, target) in ALIASES) add(alias, target, true)
        cands = all.values.toList()
    }

    val size: Int get() = cands.size

    /** The place [raw] most likely means, or null when it is not a place we know. */
    fun resolve(raw: String): Fix? {
        val q = strip(fold(raw))
        val j = joined(q)
        if (j.length < 3 || q in NOT_PLACES) return null
        exact[j]?.let { return Fix(it, 0.0, false) }
        if (j.length < MIN_QUERY_LEN || q.split(' ').any { it in GENERIC }) return null
        val code = koelner(j)
        // One pass keeps the best name overall and the best well-known name; only scores up to CONFIRM matter, so the
        // length bound and the sound distance (short codes) skip most names before the spelling distance is computed.
        var best: Cand? = null
        var bestScore = CONFIRM + 1e-9
        var bestKnown: Cand? = null
        var bestKnownScore = CONFIRM + 1e-9
        for (c in cands) {
            if (c.code.isEmpty() || code.isEmpty() || c.code[0] != code[0]) continue // a name starts with the same sound ("swinger" / "zwinger": both 8)
            val limit = if (c.known) maxOf(bestScore, bestKnownScore) else bestScore
            val lenJ = maxOf(j.length, c.joined.length)
            val lenK = maxOf(code.length, c.code.length, 1)
            val soundBound = 0.5 * abs(code.length - c.code.length) / lenK
            if (0.5 * abs(j.length - c.joined.length) / lenJ + soundBound >= limit) continue
            val sound = 0.5 * levenshtein(code, c.code) / lenK
            if (0.5 * abs(j.length - c.joined.length) / lenJ + sound >= limit) continue
            val maxEdits = ((limit - sound) * 2 * lenJ).toInt() // more edits than this cannot beat the limit
            val s = sound + 0.5 * levenshtein(j, c.joined, maxEdits) / lenJ
            if (s < bestScore) { bestScore = s; best = c }
            if (c.known && s < bestKnownScore) { bestKnownScore = s; bestKnown = c }
        }
        return when {
            best != null && bestScore <= ACCEPT -> Fix(best.name, bestScore, false)
            bestKnown != null && bestKnownScore <= ACCEPT -> Fix(bestKnown.name, bestKnownScore, false)
            bestKnown != null -> Fix(bestKnown.name, bestKnownScore, true) // within CONFIRM: "Did you mean …?"
            else -> null
        }
    }

    companion object {
        const val ACCEPT = 0.35
        const val CONFIRM = 0.47
        private const val MIN_FUZZY_LEN = 5
        private const val MIN_QUERY_LEN = 4

        /** Where the map build puts the searchable places (web/build.mjs → assets/charm/map/derived/). */
        const val POIS_ASSET = "charm/map/derived/pois.json"

        /** Well-known names, always candidates (also when the map data is missing). */
        val CORE = listOf(
            "Hauptbahnhof", "Frauenkirche", "Zwinger", "Semperoper", "Neustadt", "Altstadt", "Altmarkt", "Neumarkt", "Postplatz",
            "Albertplatz", "Fürstenzug", "Großer Garten", "Blaues Wunder", "Yenidze", "Albertinum",
            "Residenzschloss", "Hofkirche", "Kreuzkirche", "Brühlsche Terrasse", "Pirnaischer Platz", "Theaterplatz",
            "Bahnhof Neustadt", "Augustusbrücke", "Kunsthofpassage", "Pfunds Molkerei", "Prager Straße", "Hygiene-Museum",
            "Gläserne Manufaktur", "Waldschlösschenbrücke", "Zoo", "Panometer", "Pillnitz", "Loschwitz",
        )

        /** English names and descriptions for a place. */
        val ALIASES = mapOf(
            "train station" to "Hauptbahnhof", "main station" to "Hauptbahnhof", "central station" to "Hauptbahnhof",
            "main train station" to "Hauptbahnhof", "station" to "Hauptbahnhof", "central train station" to "Hauptbahnhof", "railway station" to "Hauptbahnhof",
            "semper opera" to "Semperoper", "semper opera house" to "Semperoper", "opera house" to "Semperoper", "the opera" to "Semperoper",
            "old town" to "Altstadt", "new town" to "Neustadt",
        )

        /** Words that are never a place to repair: they go to the map search as they are. */
        private val NOT_PLACES = setOf("home", "here", "there", "me", "you", "it", "this", "that", "party", "north", "south", "east", "west")

        /** Words that make the slot a kind of place or a person, not a misheard name: the map search gets these as heard. */
        private val GENERIC = setOf(
            "my", "your", "our", "his", "her", "their", "best", "nearest", "closest", "good", "nice", "stop", "stops", "toilet", "toilets",
            "wc", "bathroom", "pharmacy", "cafe", "coffee", "restaurant", "pizza", "food", "bar", "supermarket", "shop", "hospital",
            "hotel", "museum", "street", "exit", "entrance", "kitchen", "car", "party", "friend", "friends",
        )

        /** "Dresden Hauptbahnhof", "the dresdner zwinger", "dredged in half benef" (how Moonshine hears "Dresden"). */
        private val PREFIX = Regex("^(?:the|dresden|dresdner|dresdn|dresdin|dredged in|dresden's)\\s+")

        private fun fold(s: String) = s.lowercase().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss").trim()

        private fun strip(s: String): String {
            var q = s
            while (true) {
                val next = PREFIX.replaceFirst(q, "")
                if (next == q || next.isBlank()) return q
                q = next
            }
        }

        /** The name the page searches: lowercase, a "Dresden" prefix dropped ("Dresden Hauptbahnhof" → "hauptbahnhof"). */
        private fun canonical(name: String): String {
            val l = name.lowercase().trim()
            val s = Regex("^dresden[ -]+").replaceFirst(l, "")
            return s.ifBlank { l }
        }

        /** Letters only, umlauts folded: "Großer Garten" → "grossergarten". */
        internal fun joined(s: String): String {
            val f = fold(s)
            val b = StringBuilder(f.length)
            for (ch in f) if (ch in 'a'..'z') b.append(ch)
            return b.toString()
        }

        /** Kölner Phonetik of letters a–z (the code for German names): "hauptbahnhof" → "0121063". */
        internal fun koelner(s: String): String {
            val out = StringBuilder()
            for (i in s.indices) {
                val ch = s[i]
                val n = if (i + 1 < s.length) s[i + 1] else ' '
                val c = when {
                    ch in "aeijouy" -> "0"
                    ch == 'h' -> ""
                    ch == 'b' || (ch == 'p' && n != 'h') -> "1"
                    ch == 'd' || ch == 't' -> if (n in "csz") "8" else "2"
                    ch in "fvw" || ch == 'p' -> "3"
                    ch in "gkq" -> "4"
                    ch == 'c' -> if (n in "ahkloqrux") "4" else "8"
                    ch == 'x' -> "48"
                    ch == 'l' -> "5"
                    ch == 'm' || ch == 'n' -> "6"
                    ch == 'r' -> "7"
                    ch == 's' || ch == 'z' -> "8"
                    else -> ""
                }
                out.append(c)
            }
            val dedup = StringBuilder()
            for (ch in out) if (dedup.isEmpty() || dedup.last() != ch) dedup.append(ch)
            if (dedup.isEmpty()) return ""
            return dedup[0] + dedup.substring(1).replace("0", "")
        }

        /** Edit distance; stops early once every path costs more than [max] (the result is then just above [max]). */
        internal fun levenshtein(a: String, b: String, max: Int = Int.MAX_VALUE): Int {
            if (a == b) return 0
            if (a.isEmpty()) return b.length
            if (b.isEmpty()) return a.length
            val d = IntArray(b.length + 1) { it }
            for (i in 1..a.length) {
                var prev = d[0]
                d[0] = i
                var rowMin = i
                for (j in 1..b.length) {
                    val tmp = d[j]
                    d[j] = minOf(d[j] + 1, d[j - 1] + 1, prev + if (a[i - 1] == b[j - 1]) 0 else 1)
                    prev = tmp
                    if (d[j] < rowMin) rowMin = d[j]
                }
                if (rowMin > max) return max + 1
            }
            return d[b.length]
        }

        /** Card ids in facts.json that are about Val or a topic, not a place. */
        private val NOT_PLACE_CARDS = Regex(
            "^(?:val-.*|trams|tickets|sbahn|augustus|augustus-heart|stollen|eierschecke|flood-2002|unesco|gdr|feb-13|" +
                "bombing-1945|valley-of-clueless|peaceful-revolution|saxony|saxon-.*|silicon-saxony|caspar-david-friedrich|sistine-madonna|" +
                "vermeer|canaletto|old-masters|staatskapelle|kreuzchor|dynamo|lingner|green-vault-heist|turkish-chamber|" +
                "lemon-squeezer|elberadweg|paddle-steamers|bunte-republik|prague|berlin|meissen|moritzburg|radebeul)$",
        )

        /** Station and sight names from pois.json ({"cats": [...], "pois": [[name, cat, lat, lon], ...]}). */
        fun poiNames(json: String): List<String> {
            val o = JSONObject(json)
            val cats = o.getJSONArray("cats")
            val wanted = (0 until cats.length()).filter { cats.optString(it) == "station" || cats.optString(it) == "sight" }.toSet()
            val pois = o.getJSONArray("pois")
            val out = ArrayList<String>()
            for (i in 0 until pois.length()) {
                val p = pois.optJSONArray(i) ?: continue
                if (p.optInt(1, -1) in wanted) p.optString(0).takeIf { it.isNotBlank() }?.let(out::add)
            }
            return out
        }

        /**
         * Place keys from facts.json: every key of a place card, mapped to its first key ("frauen kirche" → "frauenkirche").
         * A card about one side of another card ("frauenkirche-height") is skipped: its keys are questions, not names.
         */
        fun factPlaces(json: String): Map<String, String> {
            val arr = JSONObject(json).getJSONArray("cards")
            val ids = (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.optString("id") }.toSet()
            val out = LinkedHashMap<String, String>()
            for (i in 0 until arr.length()) {
                val c = arr.optJSONObject(i) ?: continue
                val id = c.optString("id")
                if (NOT_PLACE_CARDS.matches(id) || id.substringBefore('-', "") in ids) continue
                val keys: JSONArray = c.optJSONArray("keys") ?: continue
                val first = keys.optString(0).takeIf { it.isNotBlank() } ?: continue
                for (k in 0 until keys.length()) keys.optString(k).takeIf { it.isNotBlank() }?.let { out[it] = first }
            }
            return out
        }

        /** Well-known names and English aliases only: what the router uses until the map data is loaded. */
        fun core(): PlaceFix = PlaceFix(emptyList())

        /** All candidates: pois.json stations and sights, the facts.json place keys, the core names and aliases. */
        fun build(poisJson: String?, factsJson: String?): PlaceFix {
            val pois = poisJson?.let { runCatching { poiNames(it) }.getOrNull() }.orEmpty()
            val facts = factsJson?.let { runCatching { factPlaces(it) }.getOrNull() }.orEmpty()
            return PlaceFix(pois, facts)
        }

        /** Reads the bundled assets; anything missing just leaves fewer candidates. */
        fun fromAssets(assets: AssetManager): PlaceFix {
            fun read(path: String) = runCatching { assets.open(path).bufferedReader().use { it.readText() } }.getOrNull()
            return build(read(POIS_ASSET), read("facts.json"))
        }
    }
}
