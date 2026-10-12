package io.github.haardhikk.charm

/**
 * Val's short-term memory of the conversation, so follow-ups work ("how tall is the Frauenkirche?" → "when was it
 * built?"). The last [MAX_TURNS] turns, each what was heard, what Val said and its main subject ([Turn.topic]: a fact
 * card's subject, a place, a photo's subject). In memory only: never written to disk, never logged, gone on restart;
 * forgotten after [EXPIRE_MS] of silence, on "forget that", and when a feature opens. Times are uptime ms passed in by
 * the caller (pure, unit-tested). Thread-safe: turns start on the voice thread, Val's words arrive on the main thread.
 */
class ConversationMemory {

    /** [thing]: the topic is something seen in a photo (a mug), never a place to walk to. */
    data class Turn(val heard: String, val said: String?, val topic: String?, val at: Long, val thing: Boolean = false)

    private val turns = ArrayDeque<Turn>()

    /** A new turn ([heard] is what the user said); the oldest goes once there are more than [MAX_TURNS]. */
    @Synchronized
    fun record(heard: String, topic: String?, now: Long, thing: Boolean = false) {
        expire(now)
        turns.addLast(Turn(cut(heard), null, topic?.let(::cut), now, thing && topic != null))
        while (turns.size > MAX_TURNS) turns.removeFirst()
    }

    /** Val's reply to the newest turn (the last reply wins); ignored when no turn is that recent ([SAY_WINDOW_MS]). */
    @Synchronized
    fun said(text: String, now: Long): Boolean = updateNewest(now) { it.copy(said = cut(text)) }

    /** The newest turn's subject, learnt late (a photo's caption arrives after the question). */
    @Synchronized
    fun learnTopic(topic: String, now: Long): Boolean = updateNewest(now) { it.copy(topic = cut(topic), thing = true) }

    private inline fun updateNewest(now: Long, change: (Turn) -> Turn): Boolean {
        val t = turns.lastOrNull() ?: return false
        if (now - t.at !in 0..SAY_WINDOW_MS) return false
        turns[turns.size - 1] = change(t)
        return true
    }

    /** The turns still remembered, oldest first (all of them go after [EXPIRE_MS] of silence). */
    @Synchronized
    fun recent(now: Long): List<Turn> {
        expire(now)
        return turns.toList()
    }

    @Synchronized
    fun clear(): Int = turns.size.also { turns.clear() }

    private fun expire(now: Long) {
        val last = turns.lastOrNull() ?: return
        if (now - last.at !in 0..EXPIRE_MS) turns.clear()
    }

    companion object {
        const val MAX_TURNS = 3
        const val EXPIRE_MS = 5 * 60_000L
        /** Val's reply belongs to the newest turn only this long after it (a GPS wait can take a minute). */
        const val SAY_WINDOW_MS = 90_000L
        /** Longest remembered text per side of a turn. */
        const val MAX_TEXT = 200
        /** What memory may add to a chat prompt: about 150 tokens (about 4 characters a token). */
        const val CHAT_BUDGET_CHARS = 600
        const val CHARS_PER_TOKEN = 4

        private fun cut(s: String): String {
            val t = s.replace(Regex("\\s+"), " ").trim()
            if (t.length <= MAX_TEXT) return t
            val c = t.substring(0, MAX_TEXT)
            return c.substring(0, c.lastIndexOf(' ').takeIf { it > MAX_TEXT / 2 } ?: MAX_TEXT).trim() + "…"
        }

        /** Short enough to lean on the turn before: longer sentences carry their own subject. */
        private const val MAX_FOLLOW_UP_WORDS = 8
        private val POINTERS = setOf("it", "its", "it's", "that", "that's", "there", "they", "they're", "them", "their", "he", "he's", "she", "she's", "him", "her", "his", "those")
        private val OPENERS = Regex("^(?:and|but|so|also|what about|how about|and what about|then)\\b")
        private val WHOLE = Regex(
            "^(?:tell me more|more|say more|go on|keep going|continue|and then|why|why not|why is that|how come|really|is that true|" +
                "how old|what else|anything else|what happened (?:next|then|after that)|tell me more about (?:it|that|them|him|her)|more about (?:it|that))$",
        )
        private val HOW_OLD = Regex("\\bhow old\\b(?! are you)")
        /** "It" and "there" that point at nothing ("what time is it", "is it raining", "is there a toilet"). */
        private val DUMMY = Regex(
            "\\b(?:time|day|date|weather) is it\\b|\\bis it (?:raining|snowing|cold|hot|warm|sunny|windy|dark|light|late|early|night|day|morning|evening)\\b|" +
                "^there$|\\b(?:is|are) there\\b|\\b(?:hi|hello|hey) there\\b|\\bthat's (?:all|it|enough|cool|great|nice|funny|awesome|amazing|right|ok|okay)\\b|" +
                "\\bthank(?:s| you)\\b|\\bstop (?:it|that)\\b|\\bforget (?:it|that)\\b",
        )

        /** True when [text] (normalised) is a follow-up that leans on the turn before: short, with a pronoun or an ellipsis. */
        fun isFollowUp(text: String): Boolean {
            val t = text.trim()
            if (t.isEmpty()) return false
            val words = t.split(' ').filter { it.isNotEmpty() }
            if (words.size > MAX_FOLLOW_UP_WORDS) return false
            if (WHOLE.matches(t) || OPENERS.containsMatchIn(t) || HOW_OLD.containsMatchIn(t)) return true
            if (DUMMY.containsMatchIn(t)) return false
            return words.any { it in POINTERS }
        }

        /** A follow-up with the remembered subject added for the card lookup ("when was it built" → "… frauenkirche"). */
        fun withTopic(text: String, topic: String): String =
            if (Facts.tokens(text).containsAll(Facts.tokens(topic))) text else "$text ${topic.lowercase()}"

        /**
         * Remembered turns as (user, Val) pairs for the chat prompt, oldest first: the newest that fit in [budget]
         * characters, each side already cut to [MAX_TEXT]. Turns Val never answered are left out.
         */
        fun chatTurns(turns: List<Turn>, budget: Int = CHAT_BUDGET_CHARS): List<Pair<String, String>> {
            val out = ArrayList<Pair<String, String>>()
            var used = 0
            for (t in turns.asReversed()) {
                val said = t.said ?: continue
                val size = t.heard.length + said.length + WRAP_CHARS
                if (used + size > budget) break
                used += size
                out += t.heard to said
            }
            return out.asReversed()
        }

        /** `<said></said>` around each remembered question. */
        private const val WRAP_CHARS = 13

        /** Rough token count of what [chatTurns] adds (for the log). */
        fun tokens(pairs: List<Pair<String, String>>): Int =
            pairs.sumOf { (h, s) -> h.length + s.length + WRAP_CHARS } / CHARS_PER_TOKEN

        private val ARTICLE_THING = Regex("\\b(?:a|an|the|some)\\s+((?:[a-z'-]+\\s+){0,2}?[a-z'-]+?)(?=\\s+(?:on|in|with|of|that|which|and|sitting|lying|next|near|at|from|under|against|is|are)\\b|[,.;!?]|$)")
        private val NOT_THINGS = setOf("photo", "picture", "image", "close", "closeup", "close-up", "view", "lot", "bit", "kind", "sort", "type")

        /** The thing a photo caption is about ("It looks like a red coffee mug on a desk." → "red coffee mug"), or null. */
        fun captionSubject(caption: String): String? {
            val c = caption.lowercase()
            return ARTICLE_THING.findAll(c).map { it.groupValues[1].trim() }
                .firstOrNull { s -> s.isNotEmpty() && s.split(' ').last() !in NOT_THINGS }
        }

        /** "Take me there", "how do I get there": navigation to the remembered place. Whole sentences only. */
        private val THERE = Regex(
            "^(?:(?:can|could|will|would) you |let's |lets |please )?(?:take|bring|guide|walk|lead|get) (?:me|us) there$|" +
                "^(?:let's |lets )?(?:go|walk|head) there$|^how (?:do|can) (?:i|we) (?:get|walk|go) there$|^(?:navigate|directions|show me the way)(?: me| us)? there$|" +
                "^(?:give me |get me )?directions(?: to it)?$|^(?:how far(?: away)? is it|which way is it|where is it|show (?:it|me) on the map|show me where it is)$",
        )

        fun isThere(text: String): Boolean = THERE.matches(text.trim())
    }
}
