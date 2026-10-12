package io.github.haardhikk.charm

import android.content.ComponentCallbacks2
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LifecycleTest {

    @Test
    fun releasePinsItselfOncePerProcess() {
        assertTrue(shouldAutoPin(pinned = false, charmModeOff = false, debug = false, tried = false))
        assertFalse("declined once: not asked again until next launch", shouldAutoPin(false, false, false, tried = true))
        assertFalse(shouldAutoPin(pinned = true, charmModeOff = false, debug = false, tried = false))
        assertFalse(shouldAutoPin(pinned = false, charmModeOff = true, debug = false, tried = false))
        assertFalse(shouldAutoPin(pinned = false, charmModeOff = false, debug = true, tried = false))
    }

    @Test
    fun screenOffKeepsTheWarmVisionModel() {
        assertFalse(trimFreesVision(ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN))
        assertFalse(trimFreesVision(ComponentCallbacks2.TRIM_MEMORY_BACKGROUND))
        assertFalse(trimFreesVision(ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE))
        assertTrue(trimFreesVision(ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW))
        assertTrue(trimFreesVision(ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL))
        assertTrue(trimFreesVision(ComponentCallbacks2.TRIM_MEMORY_MODERATE))
        assertTrue(trimFreesVision(ComponentCallbacks2.TRIM_MEMORY_COMPLETE))
    }

    @Test
    fun locationAsksOnceThenOnceMoreOnAnExplicitMapOpen() {
        assertTrue(LocationFeed.mayAsk(0, explicit = false))
        assertFalse("a resume never re-asks", LocationFeed.mayAsk(1, explicit = false))
        assertTrue(LocationFeed.mayAsk(1, explicit = true))
        assertFalse(LocationFeed.mayAsk(2, explicit = true))
        assertEquals(false, LocationFeed.mayAsk(5, explicit = true))
    }

    @Test
    fun everyFixCarriesItsAge() {
        val nine = 9 * 60_000L
        assertEquals(nine, LocationFeed.fixAgeMs(1_000_000_000_000L + nine * 1_000_000, 1_000_000_000_000L))
        assertEquals("a clock glitch never gives a negative age", 0L, LocationFeed.fixAgeMs(5, 10_000_000))
        val m = LocationFeed.fixMessage(51.05, 13.74, 12.0, null, nine)
        assertEquals("fix", m.getString("type"))
        assertEquals(nine, m.getLong("ageMs"))
        assertFalse(m.has("heading"))
        assertEquals(90.0, LocationFeed.fixMessage(51.05, 13.74, 12.0, 90.0, 0).getDouble("heading"), 0.0)
    }
}
