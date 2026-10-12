package io.github.haardhikk.charm

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MessagesTest {

    @Test
    fun polaroidEventsParse() {
        assertEquals(PageEvent.Polaroid(true), PageEvent.parse("""{"type":"polaroid","on":true}"""))
        assertEquals(PageEvent.Polaroid(false), PageEvent.parse("""{"type":"polaroid"}"""))
    }

    @Test
    fun sayEventsSayWhetherTheyAnswerTheUser() {
        assertEquals(PageEvent.Say("Hi!", reply = true), PageEvent.parse("""{"type":"say","text":"Hi!","reply":true}"""))
        assertEquals(PageEvent.Say("Time's up!", reply = false), PageEvent.parse("""{"type":"say","text":"Time's up!"}"""))
        assertEquals(PageEvent.Said("Okay."), PageEvent.parse("""{"type":"said","text":"Okay."}"""))
        assertNull(PageEvent.parse("""{"type":"said","text":"  "}"""))
    }

    @Test
    fun motionMessageIsValidJsonWithThreeAxes() {
        val raw = MotionMessage.encode(1234, floatArrayOf(0.1f, 9.8f, 0.3f), floatArrayOf(0f, 0f, 0f), floatArrayOf(1f, -2f, 3.5f))
        val json = JSONObject(raw)
        assertEquals("motion", json.getString("type"))
        assertEquals(1234, json.getLong("t"))
        assertEquals(9.8, json.getJSONArray("g").getDouble(1), 1e-3)
        assertEquals(3.5, json.getJSONArray("w").getDouble(2), 1e-3)
    }

    @Test
    fun metalOnAndOffParse() {
        assertEquals(PageEvent.Metal(true), PageEvent.parse("""{"type":"metal","on":true}"""))
        assertEquals(PageEvent.Metal(false), PageEvent.parse("""{"type":"metal","on":false}"""))
        assertEquals(PageEvent.Metal(false), PageEvent.parse("""{"type":"metal"}"""))
    }

    @Test
    fun hapticRequestsParse() {
        val e = PageEvent.parse("""{"type":"haptic","pattern":"tumble"}""")
        assertEquals(PageEvent.Haptic(HapticPattern.TUMBLE), e)
    }

    @Test
    fun screenSleepAndWakeParse() {
        assertEquals(PageEvent.Screen(sleep = true), PageEvent.parse("""{"type":"screen","mode":"sleep"}"""))
        assertEquals(PageEvent.Screen(sleep = false), PageEvent.parse("""{"type":"screen","mode":"awake"}"""))
    }

    @Test
    fun junkAndUnknownMessagesAreIgnored() {
        assertNull(PageEvent.parse("not json"))
        assertNull(PageEvent.parse("""{"type":"launch-missiles"}"""))
        assertNull(PageEvent.parse("""{"type":"haptic","pattern":"nope"}"""))
    }

    @Test
    fun hapticsAreShort() {
        assertTrue(HapticPattern.entries.all { it.durationMs in 1..300 })
    }
}
