package io.github.haardhikk.charm

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ConversationMemoryTest {

    private val facts = Facts.parse(File("src/main/assets/facts.json").readText())
    private val everyday = Facts.parse(File("src/main/assets/everyday.json").readText())

    private fun pick(text: String) = Facts.choose(facts.lookup(text), everyday.lookup(text))

    /** The newest remembered subject (as MainActivity.route reads it). */
    private fun ConversationMemory.topic(now: Long) = recent(now).lastOrNull { it.topic != null }?.topic

    @Test
    fun theRingKeepsTheLastThreeTurns() {
        val m = ConversationMemory()
        for (i in 1..5) m.record("question $i", null, i * 1_000L)
        assertEquals(listOf("question 3", "question 4", "question 5"), m.recent(5_000).map { it.heard })
    }

    @Test
    fun valsReplyJoinsTheNewestTurnOnlyWhileItIsRecent() {
        val m = ConversationMemory()
        assertFalse("no turn yet", m.said("hello", 0))
        m.record("how tall is the frauenkirche", "frauenkirche", 1_000)
        assertTrue(m.said("About 91 metres.", 2_000))
        assertTrue("the last reply wins", m.said("I think about 91 metres.", 3_000))
        assertEquals("I think about 91 metres.", m.recent(3_000).last().said)
        assertFalse("a timer line minutes later is not this turn's reply", m.said("Time's up!", 1_000 + ConversationMemory.SAY_WINDOW_MS + 1))
        assertEquals("I think about 91 metres.", m.recent(100_000).last().said)
    }

    @Test
    fun turnsExpireAfterFiveMinutesOfSilence() {
        val m = ConversationMemory()
        m.record("how tall is the frauenkirche", "frauenkirche", 0)
        m.record("when was it built", "frauenkirche", 60_000)
        assertEquals(2, m.recent(60_000 + ConversationMemory.EXPIRE_MS).size)
        assertEquals("frauenkirche", m.topic(60_000 + ConversationMemory.EXPIRE_MS))
        assertTrue(m.recent(60_001 + ConversationMemory.EXPIRE_MS).isEmpty())
        assertNull(m.topic(60_001 + ConversationMemory.EXPIRE_MS))
        // A new turn after the silence starts a fresh memory.
        m.record("hello", null, 10 * 60_000L)
        assertEquals(listOf("hello"), m.recent(10 * 60_000L).map { it.heard })
    }

    @Test
    fun forgetClearsEverything() {
        val m = ConversationMemory()
        m.record("how tall is the frauenkirche", "frauenkirche", 0)
        m.said("About 91 metres.", 10)
        assertEquals(1, m.clear())
        assertTrue(m.recent(20).isEmpty())
        assertNull(m.topic(20))
        assertFalse(m.said("late reply", 30))
    }

    @Test
    fun theTopicIsTheNewestKnownSubject() {
        val m = ConversationMemory()
        m.record("tell me about the zwinger", "zwinger", 0)
        m.record("set a timer for one minute", null, 1_000)
        assertEquals("zwinger", m.topic(2_000))
        m.record("what is this", null, 3_000)
        assertTrue(m.learnTopic("red coffee mug", 20_000))
        assertEquals("red coffee mug", m.topic(20_000))
        assertTrue("a photo's thing is never a place to walk to", m.recent(20_000).last().thing)
        assertFalse(m.recent(20_000).first().thing)
    }

    @Test
    fun longTextsAreCut() {
        val m = ConversationMemory()
        m.record("word ".repeat(100), null, 0)
        m.said("x".repeat(500), 1)
        val t = m.recent(1).single()
        assertTrue(t.heard.length <= ConversationMemory.MAX_TEXT + 1)
        assertTrue(t.said!!.length <= ConversationMemory.MAX_TEXT + 1)
    }

    @Test
    fun followUpsAreDetected() {
        val yes = listOf(
            "when was it built", "and how old is it", "how old is it", "how old", "tell me more", "more", "why", "why is that",
            "how come", "what about the zwinger", "and the semperoper", "how about the zoo", "who built it", "is it open on sundays",
            "what is it made of", "how tall is that", "what's inside it", "who lives there", "can i go inside there", "when did they build it",
            "who was he", "what did she do", "is that true", "really", "go on", "tell me more about it", "what else", "and then",
            "how big is its dome", "so what happened next",
        )
        for (q in yes) assertTrue("follow-up: \"$q\"", ConversationMemory.isFollowUp(Router.normalize(q)))
        val no = listOf(
            "how tall is the frauenkirche", "tell me a joke", "what time is it", "what day is it", "is it raining", "is it dark outside",
            "is there a toilet nearby", "hello there", "thanks that's great", "set a timer for five minutes", "who are you",
            "how old are you", "why is the sky blue and what makes the clouds look so white today", "stop it", "forget that",
            "what's the weather like", "where is the zwinger", "",
        )
        for (q in no) assertFalse("not a follow-up: \"$q\"", ConversationMemory.isFollowUp(Router.normalize(q)))
    }

    @Test
    fun theTopicCarriesIntoTheCardLookup() {
        val first = pick(Router.normalize("how tall is the frauenkirche"))!!
        assertEquals("frauenkirche-height", first.hit.card.id)
        val topic = facts.subject(first.hit.card)
        assertEquals("frauenkirche", topic)
        val follow = Router.normalize("when was it built")
        assertNull("the follow-up alone has no card", pick(follow))
        val carried = pick(ConversationMemory.withTopic(follow, topic!!))!!
        assertEquals("frauenkirche-built", carried.hit.card.id)
        assertEquals(Facts.Mode.DIRECT, carried.hit.mode)
        assertTrue(carried.hit.card.text.contains("built from 1726"))
        // Chains keep going: "how old is it" and "tell me more" stay on the Frauenkirche.
        assertEquals("frauenkirche", pick(ConversationMemory.withTopic(Router.normalize("tell me more"), topic))?.hit?.card?.id)
        val rebuilt = pick(ConversationMemory.withTopic(Router.normalize("and when was it rebuilt"), topic))!!
        assertEquals("frauenkirche-rebuilt", rebuilt.hit.card.id)
        // A follow-up that names its own subject keeps it.
        assertEquals("zwinger", pick(Router.normalize("what about the zwinger"))?.hit?.card?.id)
        // The topic is not added twice.
        assertEquals("how tall is the frauenkirche", ConversationMemory.withTopic("how tall is the frauenkirche", "frauenkirche"))
    }

    @Test
    fun cardSubjects() {
        val cards = JSONObject(File("src/main/assets/facts.json").readText()).getJSONArray("cards")
        fun card(id: String): Facts.Card {
            val o = (0 until cards.length()).map { cards.getJSONObject(it) }.first { it.getString("id") == id }
            val keys = o.getJSONArray("keys").let { a -> (0 until a.length()).map { a.getString(it) } }
            return Facts.Card(id, keys, emptyList(), o.getString("text"))
        }
        assertEquals("frauenkirche", facts.subject(card("frauenkirche-cross")))
        assertEquals("zwinger", facts.subject(card("zwinger-museums")))
        assertEquals("old masters", facts.subject(card("old-masters")))
        assertNull("cards about Val carry no topic", facts.subject(card("val-offline")))
    }

    @Test
    fun takeMeThere() {
        for (q in listOf("take me there", "can you take me there", "how do i get there", "let's go there", "directions", "how far is it", "which way is it", "navigate there")) {
            assertTrue("there: \"$q\"", ConversationMemory.isThere(Router.normalize(q)))
        }
        for (q in listOf("take me to the zoo", "is there a toilet", "where is the zwinger", "how far is the moon")) {
            assertFalse("not there: \"$q\"", ConversationMemory.isThere(Router.normalize(q)))
        }
        val cmd = Router.navigateTo("frauenkirche")
        assertEquals("navigate_to", cmd.name)
        assertTrue(cmd.args.getString("place").isNotBlank())
    }

    @Test
    fun forgetIsARule() {
        for (q in listOf("forget that", "forget it", "new topic", "change the topic", "let's talk about something else", "never mind", "hey val forget what i said")) {
            assertEquals("forget: \"$q\"", "forget_context", Router.rule(Router.normalize(q))?.name)
        }
        assertEquals("timer", Router.rule(Router.normalize("forget the timer"))?.name)
        assertEquals("remember_note", Router.rule(Router.normalize("remember my locker is 42"))?.name)
        assertTrue(Router.acts(Router.rule("forget that")!!))
    }

    @Test
    fun chatTurnsFitTheBudgetNewestFirst() {
        val turns = listOf(
            ConversationMemory.Turn("how tall is the frauenkirche", "I think it is about 91 metres tall.", "frauenkirche", 0),
            ConversationMemory.Turn("set a timer", null, null, 1),
            ConversationMemory.Turn("when was it built", "It was built from 1726 to 1743.", "frauenkirche", 2),
        )
        val pairs = ConversationMemory.chatTurns(turns)
        assertEquals(listOf("how tall is the frauenkirche", "when was it built"), pairs.map { it.first })
        assertTrue(ConversationMemory.tokens(pairs) <= 150)
        val long = List(3) { ConversationMemory.Turn("q".repeat(200), "a".repeat(200), null, it.toLong()) }
        val fitted = ConversationMemory.chatTurns(long)
        assertEquals("only the newest fits", 1, fitted.size)
        assertTrue(ConversationMemory.tokens(fitted) <= 150)
    }

    @Test
    fun captionSubjects() {
        assertEquals("red coffee mug", ConversationMemory.captionSubject("It looks like a red coffee mug on a wooden desk."))
        assertEquals("laptop", ConversationMemory.captionSubject("This is a photo of a laptop."))
        assertEquals("frauenkirche", ConversationMemory.captionSubject("The Frauenkirche, a big church."))
        assertNull(ConversationMemory.captionSubject("Something blurry."))
    }
}
