package io.github.haardhikk.charm

/**
 * A reply cut into speakable chunks of about [MIN_WORDS]–[MAX_WORDS] words, so the first one is spoken while the rest
 * are still being made: sentences on `. ! ?`, long sentences at `, ; :`, anything still too long at even word breaks.
 * Short pieces join a neighbour. Pure, unit-tested.
 */
object SpeechChunks {
    const val MAX_WORDS = 12
    const val MIN_WORDS = 3
    /** Kitten's first chunk: short, so the first sample plays sooner (it is made slower than real time). */
    const val FIRST_WORDS = 5

    private val SPACES = Regex("\\s+")
    private val SENTENCE_END = Regex("(?<=[.!?…])\\s+")
    private val CLAUSE_END = Regex("(?<=[,;:])\\s+")

    /**
     * Like [split], but the first chunk has at most [firstMax] words: cut after the last `, ; :` inside them if there
     * is one, else after [firstMax] words. The rest of that chunk follows as its own chunk.
     */
    fun splitQuickStart(text: String, firstMax: Int = FIRST_WORDS): List<String> {
        val out = split(text)
        val first = out.firstOrNull() ?: return out
        val w = first.split(' ').filter { it.isNotEmpty() }
        if (w.size <= firstMax) return out
        val clause = (firstMax - 1 downTo 1).firstOrNull { w[it - 1].last() in ",;:" }
        val cut = clause ?: firstMax
        return listOf(w.take(cut).joinToString(" "), w.drop(cut).joinToString(" ")) + out.drop(1)
    }

    fun split(text: String): List<String> {
        val clean = text.replace(SPACES, " ").trim()
        if (clean.isEmpty()) return emptyList()
        val out = ArrayList<String>()
        for (piece in clean.split(SENTENCE_END).flatMap(::splitLong)) {
            val last = out.lastOrNull()
            if (last != null && (words(piece) < MIN_WORDS || words(last) < MIN_WORDS) && words(last) + words(piece) <= MAX_WORDS) {
                out[out.size - 1] = "$last $piece"
            } else {
                out += piece
            }
        }
        return out
    }

    private fun words(s: String) = s.split(' ').count { it.isNotEmpty() }

    private fun splitLong(sentence: String): List<String> {
        if (words(sentence) <= MAX_WORDS) return listOf(sentence)
        val groups = ArrayList<String>()
        var cur = ""
        for (clause in sentence.split(CLAUSE_END)) {
            cur = when {
                cur.isEmpty() -> clause
                words(cur) + words(clause) <= MAX_WORDS -> "$cur $clause"
                else -> {
                    groups += cur
                    clause
                }
            }
        }
        if (cur.isNotEmpty()) groups += cur
        return groups.flatMap { g ->
            val w = g.split(' ').filter { it.isNotEmpty() }
            if (w.size <= MAX_WORDS) {
                listOf(g)
            } else {
                val n = (w.size + MAX_WORDS - 1) / MAX_WORDS
                w.chunked((w.size + n - 1) / n).map { it.joinToString(" ") }
            }
        }
    }
}
