package io.github.haardhikk.charm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.random.Random

class PlaceFixTest {

    private val facts = File("src/main/assets/facts.json").readText()

    /** The real map names when the cache is there (after scripts/build-map-data.py); otherwise 4,000 made-up names of the same shape. */
    private val pois: List<String> = File("../../.cache/downloads/map/derived/pois.json").takeIf { it.isFile }
        ?.let { PlaceFix.poiNames(it.readText()) }
        ?: List(4000) { i -> fakeName(Random(i)) }

    private val fix = PlaceFix(pois, PlaceFix.factPlaces(facts))

    private fun fakeName(r: Random): String {
        val parts = listOf("linden", "berg", "straße", "platz", "kirche", "garten", "hof", "weg", "brücke", "markt", "dorf", "tal", "haus", "see")
        return (0..r.nextInt(1, 3)).joinToString("") { parts[r.nextInt(parts.size)] }.replaceFirstChar { it.uppercase() } + " " + r.nextInt(1, 99)
    }

    private fun accept(heard: String, place: String) {
        val f = fix.resolve(heard)
        assertEquals("\"$heard\"", place, f?.name)
        assertEquals("\"$heard\" score ${f?.score} should be accepted", false, f?.confirm)
    }

    private fun confirm(heard: String, place: String) {
        val f = fix.resolve(heard)
        assertEquals("\"$heard\"", place, f?.name)
        assertEquals("\"$heard\" score ${f?.score} should ask first", true, f?.confirm)
    }

    @Test
    fun misheardNamesAreRepaired() {
        accept("swinger", "zwinger")
        accept("svinger palace", "zwinger")
        accept("frau and kirche", "frauenkirche")
        accept("noi shtat", "neustadt")
        accept("first and sook", "fürstenzug")
        accept("pirnasher platz", "pirnaischer platz")
        accept("semper oper", "semperoper")
        accept("post platz", "postplatz")
        confirm("dredged in half benef", "hauptbahnhof")
        confirm("how bun hoff", "hauptbahnhof")
        confirm("half bun hoff", "hauptbahnhof")
        confirm("frowing church", "frauenkirche")
    }

    @Test
    fun exactNamesAndAliasesNeedNoGuess() {
        for ((heard, place) in listOf(
            "Frauenkirche" to "frauenkirche",
            "the zwinger" to "zwinger",
            "Dresden Hauptbahnhof" to "hauptbahnhof",
            "main station" to "hauptbahnhof",
            "train station" to "hauptbahnhof",
            "central station" to "hauptbahnhof",
            "semper opera" to "semperoper",
            "old town" to "altstadt",
            "new town" to "neustadt",
            "frauen kirche" to "frauenkirche",
            "grosser garten" to "großer garten",
            "zoo" to "zoo",
        )) {
            val f = fix.resolve(heard)
            assertEquals("\"$heard\"", place, f?.name)
            assertEquals("\"$heard\" exact", 0.0, f!!.score, 0.0)
        }
    }

    @Test
    fun otherWordsAreNotPlaces() {
        for (heard in listOf("the moon", "my sister", "home", "here", "mars", "a good time", "the party", "north", "it", "")) {
            val f = fix.resolve(heard)
            assertTrue("\"$heard\" -> $f", f == null || f.confirm && f.score > PlaceFix.ACCEPT && heard.length > 6)
        }
        assertNull(fix.resolve("the moon"))
        assertNull(fix.resolve("home"))
    }

    @Test
    fun theCoreListWorksWithoutTheMapData() {
        val core = PlaceFix.core()
        assertEquals("zwinger", core.resolve("swinger")?.name)
        assertEquals("hauptbahnhof", core.resolve("main station")?.name)
        assertNull(core.resolve("the moon"))
    }

    @Test
    fun aSweepOfAllNamesStaysUnderFiveMilliseconds() {
        val asks = listOf("dredged in half benef", "how bun hoff", "cleaners my friend", "prague is that real", "swinger", "something nobody has ever said")
        repeat(20) { for (a in asks) fix.resolve(a) } // warm-up
        val runs = 50
        val start = System.nanoTime()
        repeat(runs) { for (a in asks) fix.resolve(a) }
        val ms = (System.nanoTime() - start) / 1e6 / (runs * asks.size)
        assertTrue("${"%.2f".format(ms)} ms per call over ${fix.size} names", ms < 5.0)
    }

    @Test
    fun kolnerPhoneticsAndDistance() {
        assertEquals(PlaceFix.koelner("zwinger"), PlaceFix.koelner("swinger"))
        assertEquals(3, PlaceFix.levenshtein("kitten", "sitting"))
        assertEquals("grossergarten", PlaceFix.joined("Großer Garten"))
    }

    @Test
    fun factCardsGiveNamesNotQuestions() {
        val keys = PlaceFix.factPlaces(facts)
        assertEquals("frauenkirche", keys["frauen kirche"])
        assertEquals("zwinger", keys["zwinger palace"])
        assertTrue(keys.keys.none { it.startsWith("frauenkirche ") }) // "frauenkirche tall" is a question, not a name
        assertTrue("offline" !in keys)
    }
}
