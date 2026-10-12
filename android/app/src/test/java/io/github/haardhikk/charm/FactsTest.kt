package io.github.haardhikk.charm

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class FactsTest {

    private val json = File("src/main/assets/facts.json").readText()
    private val facts = Facts.parse(json)

    private fun hit(q: String) = facts.lookup(Router.normalize(q))

    private fun direct(q: String, id: String) {
        val h = hit(q)
        assertEquals("card for \"$q\"", id, h?.card?.id)
        assertEquals("mode for \"$q\" (score ${h?.score}, coverage ${h?.coverage})", Facts.Mode.DIRECT, h?.mode)
    }

    private fun context(q: String, id: String) {
        val h = hit(q)
        assertEquals("card for \"$q\"", id, h?.card?.id)
        assertEquals("mode for \"$q\" (score ${h?.score}, coverage ${h?.coverage})", Facts.Mode.CONTEXT, h?.mode)
    }

    private fun miss(q: String) = assertNull("no card for \"$q\"", hit(q))

    @Test
    fun theCardsAreWellFormed() {
        val cards = JSONObject(json).getJSONArray("cards")
        assertTrue(cards.length() in 60..120)
        assertEquals(cards.length(), facts.size)
        val ids = HashSet<String>()
        for (i in 0 until cards.length()) {
            val c = cards.getJSONObject(i)
            assertTrue("unique id ${c.getString("id")}", ids.add(c.getString("id")))
            assertTrue("${c.getString("id")} under 35 words", c.getString("text").split(Regex("\\s+")).size < 35)
            assertTrue("${c.getString("id")} has keys", c.getJSONArray("keys").length() > 0)
            assertTrue("${c.getString("id")} has a source", c.getString("src").isNotBlank())
        }
    }

    @Test
    fun clearQuestionsAreAnsweredFromTheCard() {
        direct("How tall is the Frauenkirche?", "frauenkirche-height")
        direct("how tall is the frauenkirche in dresden", "frauenkirche-height")
        direct("tell me about the Frauenkirche", "frauenkirche")
        direct("when was the frauenkirche rebuilt", "frauenkirche-rebuilt")
        direct("what is the Zwinger", "zwinger")
        direct("what's the Fürstenzug", "fuerstenzug")
        direct("what is the fuerstenzug", "fuerstenzug")
        direct("what is the Blue Wonder", "blaues-wunder")
        direct("what is the grunes gewolbe", "gruenes-gewoelbe")
        direct("how many people live in Dresden", "dresden-population")
        direct("tell me about TU Dresden", "tu-dresden")
        direct("what is the semperoper", "semperoper")
        direct("what happened in the bombing of 1945", "bombing-1945")
        direct("what is the Kunsthofpassage", "kunsthofpassage")
        direct("do you need internet", "val-offline")
        direct("hey val tell me about Pfunds Molkerei", "pfunds-molkerei")
        direct("what is Saxon Switzerland", "saxon-switzerland")
    }

    @Test
    fun aSubjectWithOtherWordsBecomesContext() {
        context("is the frauenkirche open on sundays", "frauenkirche")
        context("I want to visit the Zwinger tomorrow with my sister", "zwinger")
    }

    @Test
    fun otherQuestionsMissEveryCard() {
        miss("tell me a joke")
        miss("how are you")
        miss("how tall are you")
        miss("what's the weather like")
        miss("what time is it")
        miss("what is two plus two")
        miss("what should I cook tonight")
        miss("do you like pizza")
        miss("what is the capital of France")
        miss("can you sing a song")
        miss("")
    }

    @Test
    fun umlautsAndPluralsFold() {
        assertEquals(listOf("fuerstenzug", "bruehlsche", "terrasse"), Facts.tokens("Fürstenzug, Brühlsche Terrasse!"))
        assertEquals(listOf("tram", "grosser", "garten"), Facts.tokens("trams Großer Garten"))
        assertEquals(listOf("cafe"), Facts.tokens("Café"))
    }

    @Test
    fun lookupIsFast() {
        hit("warm up")
        val t0 = System.nanoTime()
        repeat(100) { hit("how tall is the frauenkirche in dresden") }
        val perQueryMs = (System.nanoTime() - t0) / 1e6 / 100
        assertTrue("lookup took $perQueryMs ms", perQueryMs < 5.0)
    }

    @Test
    fun contextIsShort() {
        val long = "First sentence is here and fine. " + "Second sentence goes on and on with many words to pass the limit for sure. ".repeat(3)
        val s = Facts.short(long)
        assertTrue(s.length <= Facts.CONTEXT_CHARS)
        assertTrue(s.endsWith("."))
        assertEquals("Short.", Facts.short("Short."))
    }

    @Test
    fun anExactNameOrAWholeCommonPhraseAnswersAtOnce() {
        direct("Tell me about Dresden.", "dresden")
        direct("Which phone?", "val-phone")
        miss("which")
        context("What happened in 1945 in Dresden?", "bombing-1945")
        assertEquals("elbe", hit("What river is this?")?.card?.id)
        assertEquals("elbe", hit("Which river is that?")?.card?.id)
    }
}
