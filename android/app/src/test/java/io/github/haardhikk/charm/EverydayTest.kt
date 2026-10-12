package io.github.haardhikk.charm

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ErrorCollector
import java.io.File

/** The everyday answers (assets/everyday.json) and how they sit next to the rules and the Dresden cards. */
class EverydayTest {

    /** Every miss in a test is reported, not only the first. */
    @get:Rule val errors = ErrorCollector()

    private val json = File("src/main/assets/everyday.json").readText()
    private val everyday = Facts.parse(json)
    private val dresden = Facts.parse(File("src/main/assets/facts.json").readText())

    /** What MainActivity.route does before the models: rules first, then both card files. */
    private fun card(said: String): Facts.Pick? {
        val text = Router.normalize(said)
        if (Router.rule(text) != null) return null
        return Facts.choose(dresden.lookup(text), everyday.lookup(text))
    }

    private fun says(said: String, id: String) {
        val p = card(said)
        val why = "\"$said\" -> ${p?.source}/${p?.hit?.card?.id} ${p?.hit?.mode} (score ${p?.hit?.score}, coverage ${p?.hit?.coverage})"
        if (p?.source != Facts.EVERYDAY || p.hit.card.id != id || p.hit.mode != Facts.Mode.DIRECT) errors.addError(AssertionError("want $id: $why"))
    }

    /** Never answered outright from an everyday card (a rule, a Dresden card, Needle or the chat model takes it). */
    private fun notSaid(said: String) {
        val p = card(said)
        if (p != null && p.source == Facts.EVERYDAY && p.hit.mode == Facts.Mode.DIRECT) errors.addError(AssertionError("\"$said\" -> ${p.hit.card.id} (score ${p.hit.score}, coverage ${p.hit.coverage})"))
    }

    @Test
    fun theCardsAreWellFormed() {
        val cards = JSONObject(json).getJSONArray("cards")
        assertTrue(cards.length() in 150..250)
        assertEquals(cards.length(), everyday.size)
        val ids = HashSet<String>()
        val dresdenIds = JSONObject(File("src/main/assets/facts.json").readText()).getJSONArray("cards").let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("id") }.toSet() }
        for (i in 0 until cards.length()) {
            val c = cards.getJSONObject(i)
            val id = c.getString("id")
            assertTrue("unique id $id", ids.add(id) && id !in dresdenIds)
            assertTrue("$id at most 30 words", c.getString("text").split(Regex("\\s+")).size <= 30)
            assertTrue("$id has a source", c.getString("src").isNotBlank())
            val keys = c.getJSONArray("keys")
            assertTrue("$id has keys", keys.length() > 0)
            for (k in 0 until keys.length()) {
                val words = Facts.tokens(keys.getString(k))
                assertTrue("$id key \"${keys.getString(k)}\" has a word that counts", Facts.tokens(keys.getString(k)).any { w -> everyday.lookup(w) != null || words.isNotEmpty() })
            }
        }
    }

    @Test
    fun valAnswersAboutItself() {
        says("what's your favourite food", "val-food")
        says("do you eat", "val-food")
        says("can you see me", "val-see")
        says("hey val can you hear me", "val-hear")
        says("do you store my data", "val-no-storing")
        says("are you chat gpt", "val-assistant")
        says("what model are you", "val-assistant")
        says("are you happy", "val-happy")
        says("do you sleep", "val-sleep")
        says("are you a boy or a girl", "val-gender")
        says("will you be my friend", "val-be-friend")
        says("how big are you", "val-size")
        says("can you google it", "val-browse")
        says("tell me a secret", "val-secret")
        says("what's the meaning of life", "val-meaning-life")
        says("what happens if i tilt you", "val-tilt")
        says("what are you made of", "val-made-of")
        says("where were you born", "val-born")
        says("who made you", "val-made-of")
        says("why are you here", "val-made-of")
        says("can you walk", "val-walk")
        says("will you marry me", "val-marry")
        says("what's your favorite song", "val-song")
    }

    @Test
    fun generalKnowledgeWithMessySpeech() {
        says("why is the sky blue", "sky-blue")
        says("um why is the sky so blue", "sky-blue")
        says("Hey Val, how far away is the moon?", "moon-distance")
        says("how far is the moon from earth", "moon-distance")
        says("how big is the earth", "earth-size")
        says("whats the speed of light", "speed-light")
        says("how many continents are there", "continents")
        says("how many planets are in the solar system", "planets")
        says("what's the biggest animal in the world", "biggest-animal")
        says("what is the tallest mountain", "tallest-mountain")
        says("what's the highest mountain in germany", "germany-mountain")
        says("what's the capital of France", "capital-france")
        says("what is the capitol of australia", "capital-australia")
        says("whats the capital of the us", "capital-usa")
        says("what is the capital of germany", "capital-germany")
        says("at what temperature does water boil", "water-boil")
        says("what's the boiling point of water", "water-boil")
        says("how many days are in a year", "days-year")
        says("what is a leap year", "leap-year")
        says("what is a robot", "robot")
        says("what is AI", "ai")
        says("what's artificial intelligence", "ai")
        says("how does GPS work", "gps")
        says("how does a phone camera work", "camera")
        says("who was the first man on the moon", "moon-landing")
        says("how old is the earth", "earth-age")
        says("how many people live on earth", "world-population")
        says("how many bones are in the human body", "bones")
        says("why do we have seasons", "seasons")
        says("how are rainbows made", "rainbow")
        says("what's the longest river in germany", "longest-river-germany")
        says("what's the longest river in the world", "longest-river")
        says("uh how hot is the sun", "sun-hot")
        says("what is a black hole", "black-hole")
        says("is pluto a planet", "pluto")
        says("what's the fastest animal", "fastest-animal")
        says("how does the internet work", "internet")
        says("what's the deepest part of the ocean", "deepest")
        says("why is the sea salty", "sea-salty")
        says("what is the population of germany", "germany")
    }

    @Test
    fun helpfulAndHonestAnswers() {
        says("how do you say thank you in german", "german-thanks")
        says("how do you say goodbye in german", "german-bye")
        says("what's the emergency number", "emergency")
        says("how do I call the police", "emergency")
        says("i need an ambulance", "emergency")
        says("what's the weather like", "offline-weather")
        says("will it rain today", "offline-weather")
        says("what's the news today", "offline-news")
        says("what time is it in new york", "offline-time-zone")
        says("what's the price of bitcoin", "offline-prices")
        says("who won the football last night", "offline-scores")
        says("can you call my mum", "calls")
        says("i'm bored", "games")
        says("tell me a story", "story")
        says("i'm sad", "user-sad")
        says("is the tap water safe to drink", "tap-water")
    }

    @Test
    fun otherQuestionsMissEverydayCards() {
        // Needle's actions: never answered from a card.
        notSaid("show me your map")
        notSaid("open the camera")
        notSaid("use the phone camera")
        notSaid("take a picture of the sky")
        notSaid("I want to go to the Zwinger")
        notSaid("remind me to buy milk")
        // Things only the chat model can try.
        notSaid("what should I cook tonight")
        notSaid("do you like pizza")
        notSaid("what is two plus two")
        notSaid("when was mozart born")
        notSaid("who is the best football player")
        notSaid("tell me about the history of computers and why they matter to everyone today")
        notSaid("what's the time in the timer")
        notSaid("set an alarm for seven")
        notSaid("what is your favourite thing about the zwinger")
        notSaid("how far is the frauenkirche from here")
        notSaid("i lost my keys")
        notSaid("")
    }

    @Test
    fun rulesStillRunFirst() {
        for (said in listOf(
            "what time is it", "what day is it", "what's the date", "how much battery do you have", "set a timer for 5 minutes",
            "how much time is left", "where am i", "what can you do", "how old are you", "what's your name", "are you real",
            "dance", "take a photo", "what is this", "when is sunset", "find metal", "remember my locker is 42", "where is my locker",
            "tell me a joke", "flip a coin", "roll a dice", "rock paper scissors", "sing a song", "tell me a fun fact",
        )) assertNotNull("\"$said\" is a rule", Router.rule(Router.normalize(said)))
    }

    @Test
    fun dresdenCardsAreNeverStolen() {
        for ((said, id) in listOf(
            "How tall is the Frauenkirche?" to "frauenkirche-height",
            "tell me about the Frauenkirche" to "frauenkirche",
            "what is the Zwinger" to "zwinger",
            "how many people live in Dresden" to "dresden-population",
            "tell me about TU Dresden" to "tu-dresden",
            "do you need internet" to "val-offline",
            "why are you pink" to "val-colour",
            "are you recording me" to "val-privacy",
            "how far is Prague" to "prague",
            "what is the elbe" to "elbe",
        )) {
            val p = card(said)
            assertEquals("\"$said\" -> ${p?.source}/${p?.hit?.card?.id}", Facts.DRESDEN, p?.source)
            assertEquals("\"$said\"", id, p?.hit?.card?.id)
        }
        // A Dresden subject keeps the question even when an everyday card covers the rest of it.
        val p = card("is the frauenkirche open on sundays")
        assertEquals(Facts.DRESDEN, p?.source)
        assertEquals("frauenkirche", p?.hit?.card?.id)
    }

    @Test
    fun aPartialMatchBecomesContext() {
        val p = card("I wonder if the moon is far from here when we look at it tonight with my friends")
        assertTrue(p == null || p.hit.mode == Facts.Mode.CONTEXT)
        val q = card("can you explain to me in detail why the sky is blue and not green")
        assertEquals("sky-blue", q?.hit?.card?.id)
        assertEquals(Facts.Mode.CONTEXT, q?.hit?.mode)
    }

    @Test
    fun theChooserPrefersDresden() {
        val d = dresden.lookup("frauenkirche")!!
        val e = everyday.lookup("why is the sky blue")!!
        assertEquals(Facts.DRESDEN, Facts.choose(d, e)?.source)
        assertEquals(Facts.EVERYDAY, Facts.choose(null, e)?.source)
        assertEquals(null, Facts.choose(null, null))
    }
}
