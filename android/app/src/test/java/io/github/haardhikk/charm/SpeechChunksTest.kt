package io.github.haardhikk.charm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechChunksTest {

    private fun words(s: String) = s.split(' ').count { it.isNotEmpty() }

    @Test
    fun emptyTextHasNoChunks() {
        assertEquals(emptyList<String>(), SpeechChunks.split("  \n "))
    }

    @Test
    fun shortReplyIsOneChunk() {
        assertEquals(listOf("Timer set for 1 minute!"), SpeechChunks.split("Timer set for 1 minute!"))
    }

    @Test
    fun sentencesSplitAndShortOnesJoin() {
        assertEquals(
            listOf("Woo! Watch this!", "The Frauenkirche is a church in Dresden.", "It was rebuilt in 2005."),
            SpeechChunks.split("Woo! Watch this! The Frauenkirche is a church in Dresden. It was rebuilt in 2005."),
        )
    }

    @Test
    fun decimalsAndAbbreviationDotsWithoutSpaceStayTogether() {
        assertEquals(listOf("It is 3.5 km from here."), SpeechChunks.split("It is 3.5 km from here."))
    }

    @Test
    fun longSentenceSplitsAtCommas() {
        val out = SpeechChunks.split("The Zwinger is a palace with gardens, a famous porcelain collection, and old master paintings that many people visit every year.")
        assertTrue(out.toString(), out.size >= 2)
        assertTrue(out.toString(), out.all { words(it) in 1..SpeechChunks.MAX_WORDS })
        assertTrue(out[0].endsWith(","))
    }

    @Test
    fun longSentenceWithoutPunctuationSplitsEvenly() {
        val text = (1..30).joinToString(" ") { "word$it" }
        val out = SpeechChunks.split(text)
        assertEquals(3, out.size)
        assertTrue(out.all { words(it) == 10 })
        assertEquals(text, out.joinToString(" "))
    }

    @Test
    fun quickStartKeepsAShortFirstChunk() {
        assertEquals(listOf("Hi! I'm Val.", "The Frauenkirche is a church in Dresden."), SpeechChunks.splitQuickStart("Hi! I'm Val. The Frauenkirche is a church in Dresden."))
    }

    @Test
    fun quickStartCutsTheFirstClause() {
        val out = SpeechChunks.splitQuickStart("Well, the Frauenkirche is a church in Dresden. It was rebuilt in 2005.")
        assertEquals(listOf("Well,", "the Frauenkirche is a church in Dresden.", "It was rebuilt in 2005."), out)
    }

    @Test
    fun quickStartCutsAtFiveWordsWithoutAClause() {
        val text = "The Frauenkirche is a church in Dresden. It was rebuilt in 2005."
        val out = SpeechChunks.splitQuickStart(text)
        assertEquals("The Frauenkirche is a church", out[0])
        assertTrue(out.toString(), words(out[0]) <= SpeechChunks.FIRST_WORDS)
        assertEquals(text, out.joinToString(" "))
    }

    @Test
    fun quickStartOfEmptyTextIsEmpty() {
        assertEquals(emptyList<String>(), SpeechChunks.splitQuickStart(" "))
    }

    @Test
    fun everyWordIsKeptInOrder() {
        val text = "Hi! I'm Charm, your little robot friend; I can find places, take photos, set timers and remember things for you. Ask me anything."
        assertEquals(text, SpeechChunks.split(text).joinToString(" "))
    }
}
