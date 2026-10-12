package io.github.haardhikk.charm

import org.json.JSONObject
import java.text.Normalizer
import kotlin.math.ln

/**
 * Val's fact cards, checked before the chat model so well-known facts are never made up: the Dresden cards
 * (assets/facts.json) and the everyday answers (assets/everyday.json: Val, general knowledge, honest
 * "I'm offline" replies), one instance per file, chosen between by [choose]
 * (pure, unit-tested). A tiny BM25 ranks the cards; a card counts only when one of its `keys` (the names of what it is
 * about) is in the question, never on topic words alone (`also`), so "how tall are you" never answers with a church.
 * - [Mode.DIRECT]: the question is about this card and little else → Val says the card, no model call.
 * - [Mode.CONTEXT]: the card's subject is in the question with other words → one short card goes to the chat model.
 */
class Facts private constructor(private val cards: List<Card>) {

    data class Card(val id: String, val keys: List<String>, val also: List<String>, val text: String)

    enum class Mode { DIRECT, CONTEXT }

    data class Hit(val card: Card, val score: Double, val coverage: Double, val mode: Mode)

    /** One card chosen from both files; [source] is [DRESDEN] or [EVERYDAY]. */
    data class Pick(val source: String, val hit: Hit)

    private class Key(val content: List<String>, val all: List<String>)

    private class Doc(val card: Card, val keys: List<Key>, val tf: Map<String, Int>, val len: Int)

    private val docs: List<Doc> = cards.map(::doc)
    private val avgLen = docs.map { it.len }.average().coerceAtLeast(1.0)
    private val idf: Map<String, Double> = docs.flatMap { it.tf.keys }.groupingBy { it }.eachCount()
        .mapValues { (_, df) -> ln(1 + (docs.size - df + 0.5) / (df + 0.5)) }

    val size: Int get() = cards.size

    /** The best card for [question], or null when no card's subject is in it. */
    fun lookup(question: String): Hit? {
        val all = tokens(question)
        val content = all.filter { it !in STOP }
        if (content.size > MAX_QUERY_WORDS) return null
        // A key made only of common words ("why are you here") answers when it is the whole question.
        if (content.isEmpty()) return docs.firstOrNull { d -> d.keys.any { it.content.isEmpty() && it.all == all } }?.let { Hit(it.card, 0.0, 1.0, Mode.DIRECT) }
        val asked = content.toSet()
        var best: Hit? = null
        var bestExact = false
        for (d in docs) {
            if (d.keys.none { matches(it, asked, all) }) continue
            val score = asked.sumOf { t -> d.tf[t]?.let { tf -> idf.getValue(t) * tf * (K1 + 1) / (tf + K1 * (1 - B + B * d.len / avgLen)) } ?: 0.0 }
            // The question is exactly one of the card's names ("tell me about Dresden"): the card, whatever the score.
            val exact = d.keys.any { it.content.toSet() == asked }
            if (best != null && (bestExact && !exact || bestExact == exact && score <= best.score)) continue
            val counted = asked.filter { it !in NOT_COUNTED }.ifEmpty { asked }
            val coverage = counted.count { it in d.tf }.toDouble() / counted.size
            val mode = when {
                exact || score >= DIRECT_MIN_SCORE && coverage >= DIRECT_MIN_COVERAGE -> Mode.DIRECT
                score >= CONTEXT_MIN_SCORE -> Mode.CONTEXT
                else -> continue
            }
            best = Hit(d.card, score, coverage, mode)
            bestExact = exact
        }
        return best
    }

    /**
     * What a card is about, as a topic for follow-ups (ConversationMemory): its base card's first key
     * ("frauenkirche-height" → "frauenkirche"), else its own first key. Null for cards about Val itself.
     */
    fun subject(card: Card): String? {
        if (card.id.startsWith("val-")) return null
        val base = card.id.substringBefore('-')
        return (cards.firstOrNull { it.id == base } ?: card).keys.first()
    }

    /** A key matches when all its content words are asked; a one-word key also needs its exact phrase ("are you online"). */
    private fun matches(k: Key, asked: Set<String>, all: List<String>): Boolean {
        if (k.content.isEmpty() || !asked.containsAll(k.content)) return false
        if (k.content.size >= 2 || k.all.size == 1) return true
        return (0..all.size - k.all.size).any { i -> all.subList(i, i + k.all.size) == k.all }
    }

    companion object {
        /** Direct answer: a key matched, a real BM25 score, and at least 60 % of the question's words are on the card. */
        const val DIRECT_MIN_SCORE = 3.0
        const val DIRECT_MIN_COVERAGE = 0.6
        /** Context card: a key matched and some score (a key made only of very common words scores below this). */
        const val CONTEXT_MIN_SCORE = 1.5
        /** A long ramble is for the chat model, not a card. */
        const val MAX_QUERY_WORDS = 8
        /** Longest card text sent as context: about 40 tokens. */
        const val CONTEXT_CHARS = 170
        private const val K1 = 1.2
        private const val B = 0.75

        /** Words that never count as matching (question words, articles, pronouns, polite fillers). */
        private val STOP = (
            "a an the is are was were be been being am do does did of in on at to for from by with about and or but it its " +
                "this that these those there here what which who whom whose when where why how much many tell me my i im you " +
                "your yours we us our can could would will should shall please know say some any just really very s t ll re ve d m " +
                "so like actually exactly ever wonder wondering der die das ist und"
            ).split(' ').toSet()

        /** Asked so often that they do not count against a card: "the Zwinger in Dresden" is still about the Zwinger. */
        private val NOT_COUNTED = setOf("dresden")

        /** Lowercase ASCII words: umlauts folded (ä → ae, ß → ss), other accents dropped, a plural "s" trimmed. */
        fun tokens(text: String): List<String> {
            val folded = text.lowercase()
                .replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
            val ascii = Normalizer.normalize(folded, Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "")
            return ascii.split(Regex("[^a-z0-9]+")).filter { it.isNotEmpty() }.map { if (it in STOP) it else stem(it) } // "does" and "this" stay stop words
        }

        private fun stem(w: String) = if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w.dropLast(1) else w

        /** Key and topic words count twice, the card text once. */
        private fun doc(c: Card): Doc {
            val words = (c.keys + c.also).flatMap { tokens(it) }.let { it + it } + tokens(c.text)
            val content = words.filter { it !in STOP }
            val keys = c.keys.map { k -> tokens(k).let { all -> Key(all.filter { it !in STOP }, all) } }
            return Doc(c, keys, content.groupingBy { it }.eachCount(), content.size)
        }

        /** Which file a [Pick] came from (also the page's `source` for an answer). */
        const val DRESDEN = "facts"
        const val EVERYDAY = "everyday"

        /**
         * A Dresden card wins whenever it answers outright; an everyday card answers outright when no Dresden card
         * matched, or when it covers every word of the question (so "is the Frauenkirche open on Sundays" stays a
         * Frauenkirche question). Otherwise the partial card, Dresden first, goes to the chat model as context.
         */
        fun choose(dresden: Hit?, everyday: Hit?): Pick? = when {
            dresden?.mode == Mode.DIRECT -> Pick(DRESDEN, dresden)
            everyday?.mode == Mode.DIRECT && (dresden == null || everyday.coverage >= 1.0) -> Pick(EVERYDAY, everyday)
            dresden != null -> Pick(DRESDEN, dresden)
            everyday != null -> Pick(EVERYDAY, everyday)
            else -> null
        }

        /** Parses facts.json or everyday.json; a malformed card is skipped, never fatal. */
        fun parse(json: String): Facts {
            val arr = JSONObject(json).getJSONArray("cards")
            val cards = ArrayList<Card>()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val id = o.optString("id")
                val text = o.optString("text").trim()
                val keys = o.optJSONArray("keys")?.let { a -> (0 until a.length()).map { a.optString(it) }.filter { it.isNotBlank() } }.orEmpty()
                if (id.isEmpty() || text.isEmpty() || keys.isEmpty()) continue
                val also = o.optJSONArray("also")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty()
                cards += Card(id, keys, also, text)
            }
            return Facts(cards)
        }

        /** The card cut to its first sentences within [CONTEXT_CHARS] (one sentence at least). */
        fun short(text: String): String {
            if (text.length <= CONTEXT_CHARS) return text
            val ends = Regex("[.!?](?=\\s|$)").findAll(text).map { it.range.last + 1 }.toList()
            return text.substring(0, ends.lastOrNull { it <= CONTEXT_CHARS } ?: ends.firstOrNull() ?: text.length).trim()
        }
    }
}
